#!/usr/bin/env node

/**
 * addTaskManager MCP Server
 *
 * An MCP server that integrates with addTaskManager iOS/macOS app via CloudKit.js
 * Implements the ADD (Assess-Decide-Do) framework with proper realm restrictions
 *
 * Created by: Dragos Roua
 * Framework: ADD (Assess-Decide-Do) - dragosroua.com
 *
 * Realm Restrictions:
 * - Assess (realmId 1): Can create/edit tasks/projects/ideas (name, content), cannot assign contexts or due dates.
 * - Decide (realmId 2): Can assign contexts/dates/alerts, cannot edit task/project content.
 * - Do (realmId 3): Can only mark tasks/projects as complete (sets endDate), read-only otherwise.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuidv4 } from 'uuid'; // For generating uniqueId

// --- Realm Mapping ---
const REALM_ASSESS_ID = 1;
const REALM_DECIDE_ID = 2;
const REALM_DO_ID = 3;

type RealmString = 'assess' | 'decide' | 'do';

const realmStringToId = (realmStr: RealmString): number => {
  if (realmStr === 'assess') return REALM_ASSESS_ID;
  if (realmStr === 'decide') return REALM_DECIDE_ID;
  if (realmStr === 'do') return REALM_DO_ID;
  throw new McpError(ErrorCode.InvalidParams, `Invalid realm string: ${realmStr}`);
};

const realmIdToString = (realmId: number): RealmString => {
  if (realmId === REALM_ASSESS_ID) return 'assess';
  if (realmId === REALM_DECIDE_ID) return 'decide';
  if (realmId === REALM_DO_ID) return 'do';
  throw new McpError(ErrorCode.InternalError, `Invalid realm ID: ${realmId}`);
};


// CloudKit.js types and interfaces aligned with XCDATAMODEL
interface CloudKitConfig {
  containerIdentifier: string;
  apiToken: string;
  environment: 'development' | 'production';
}

interface UserToken {
  cloudKitWebAuthToken: string;
  userIdentity: {
    userRecordName: string; // CloudKit's internal user record name
    lookupInfo: any;
  };
}

// Helper for CloudKit reference fields
interface CKReference {
  recordName: string;
  action?: 'NONE' | 'DELETE_SELF'; // CloudKit reference action
  // zoneID?: { zoneName: string; ownerRecordName?: string }; // Optional zone info
}

export interface ZenTaskticTask {
  recordName?: string; // CloudKit record name (UUID string, typically)
  recordType: 'Task';
  fields: {
    taskName: { value: string }; // Max 1000 chars, combines original title & body
    realmId: { value: number }; // 1 (Assess), 2 (Decide), 3 (Do)
    uniqueId: { value: string }; // UUID string, primary key in CoreData model
    
    // Core Data model fields
    taskId?: { value: number }; // Integer 16, default 0
    contextId?: { value: number }; // Integer 16, default 0 (legacy field)
    taskAudioRecordId?: { value: number }; // Integer 16, default 0
    taskPictureId?: { value: number }; // Integer 16, default 0
    orderInParent?: { value: number }; // Integer 16, default 0
    taskPriority?: { value: number }; // Integer 16, 1-5, default 3
    
    // References (relationships in Core Data)
    context?: { value: CKReference }; // Reference to a Contexts record
    projects?: { value: CKReference }; // Reference to a Projects record (renamed from project)
    collection?: { value: CKReference }; // Reference to a Collections record
    ideas?: { value: CKReference }; // Reference to an Ideas record (if task derived from idea)
    realms?: { value: CKReference }; // Reference to Realms record
    
    // Dates
    startDate?: { value: number }; // Timestamp (milliseconds since epoch)
    endDate?: { value: number }; // Timestamp (due date, or completion date)
    lastModified: { value: number }; // Timestamp
    
    // Task-specific fields
    localNotification?: { value: string }; // Alert date/trigger (max 100 chars)
    taskParentId?: { value: string }; // UUID string of parent Task/Project/Idea
    taskParentType?: { value: string }; // 'Task', 'Project', 'Idea'
    
    // removed isCompleted, completion handled by setting endDate & potentially realm
  };
}

export interface ZenTaskticProject {
  recordName?: string;
  recordType: 'Projects'; // Note: entity name is 'Projects' in Core Data
  fields: {
    projectName: { value: string }; // Max 1500 chars
    realmId: { value: number }; // Integer 16, default 0
    uniqueId: { value: string }; // UUID
    
    // References (relationships in Core Data)
    context?: { value: CKReference }; // Reference to Contexts record
    collection?: { value: CKReference }; // Reference to Collections record
    realm?: { value: CKReference }; // Reference to Realms record
    tasks?: { value: CKReference[] }; // List of references to Task records
    
    // Dates
    startDate?: { value: number }; // Timestamp
    endDate?: { value: number }; // Timestamp
    lastModified: { value: number }; // Timestamp
    
    // removed description (use projectName), removed isCompleted
  };
}

export interface ZenTaskticIdea {
  recordName?: string;
  recordType: 'Ideas'; // Note: entity name is 'Ideas' in Core Data
  fields: {
    ideaName: { value: string }; // Max 1500 chars, combines original title & body
    realmId: { value: number }; // Integer 16, default 0 (usually REALM_ASSESS_ID)
    uniqueId: { value: string }; // UUID
    lastModified: { value: number }; // Timestamp
    
    // References (relationships in Core Data)
    collection?: { value: CKReference }; // Reference to Collections record
    realm?: { value: CKReference }; // Reference to Realms record
    tasks?: { value: CKReference[] }; // Tasks derived from this idea
    
    // removed createdAt, use lastModified or CloudKit system creationDate
  };
}

interface ZenTaskticContext {
  recordName?: string;
  recordType: 'Contexts';
  fields: {
    contextName: { value: string }; // Max 30 chars, min 1
    uniqueId: { value: string }; // UUID
    lastModified: { value: number }; // Timestamp
    
    // References (relationships in Core Data)
    projects?: { value: CKReference[] }; // List of references to Project records
    tasks?: { value: CKReference[] }; // List of references to Task records
  };
}

interface ZenTaskticCollection {
  recordName?: string;
  recordType: 'Collections';
  fields: {
    collectionName: { value: string }; // Collection name
    uniqueId: { value: string }; // UUID, max 58 chars
    creationDate?: { value: number }; // Timestamp
    lastModified: { value: number }; // Timestamp
    
    // References (relationships in Core Data)
    ideas?: { value: CKReference[] }; // List of references to Ideas records
    projects?: { value: CKReference[] }; // List of references to Projects records
    tasks?: { value: CKReference[] }; // List of references to Task records
  };
}

interface ZenTaskticRealm {
  recordName?: string;
  recordType: 'Realms';
  fields: {
    realmId: { value: number }; // Integer 16, 1-3, default 1
    realmName?: { value: string }; // Realm name (Assess, Decide, Do)
    
    // References (relationships in Core Data)
    ideas?: { value: CKReference[] }; // List of references to Ideas records
    projects?: { value: CKReference[] }; // List of references to Projects records
    task?: { value: CKReference[] }; // List of references to Task records (note: singular in model)
  };
}


class AddTaskManagerMCPServer {
  private server: Server;
  private cloudKitConfig: CloudKitConfig;
  private userToken: UserToken | null = null;
  
  // ==================== CLOUDKIT PRODUCTION INTEGRATION ====================
  private cloudKitService?: any; // CloudKitService (imported dynamically)
  private authService?: any; // UserAuthService (imported dynamically) 
  private authMiddleware?: any; // AuthMiddleware (imported dynamically)
  private productionMode: boolean = false;
  private currentSession?: any; // UserSession

  constructor() {
    // Initialize CloudKit in production mode if environment allows
    this.initializeCloudKit().catch(error => {
      console.warn('CloudKit initialization failed, continuing with mock mode:', error);
    });

    this.server = new Server(
      {
        name: 'addtaskmanager-mcp-server',
        version: '1.1.0', // Updated version
        description: 'MCP server for addTaskManager with ADD framework support, aligned with XCDATAMODEL',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.cloudKitConfig = {
      containerIdentifier: process.env.CLOUDKIT_CONTAINER_ID || 'iCloud.com.dragosroua.zentasktic',
      apiToken: process.env.CLOUDKIT_API_TOKEN || '',
      environment: (process.env.CLOUDKIT_ENVIRONMENT as 'development' | 'production') || 'production',
    };

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Authentication
          {
            name: 'authenticate_user',
            description: 'Authenticate user with Apple ID to access their addTaskManager data',
            inputSchema: {
              type: 'object',
              properties: {
                webAuthToken: { type: 'string', description: 'CloudKit web auth token from Apple Sign-In' }
              },
              required: ['webAuthToken']
            }
          },

          // Assess Realm Tools (realmId 1)
          {
            name: 'assess_create_task',
            description: 'Create a new task in Assess realm (content editing, no contexts/dates).',
            inputSchema: {
              type: 'object',
              properties: {
                taskName: { type: 'string', description: 'Task name/description (max 1000 chars)' },
                startDate: { type: 'string', format: 'date-time', description: 'Optional start date (ISO format)' },
                taskPriority: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional task priority (1-5, default 3)'},
                projectRecordName: { type: 'string', description: 'Optional recordName of the parent project.' },
                collectionRecordName: { type: 'string', description: 'Optional recordName of the parent collection.' }
              },
              required: ['taskName']
            }
          },
          {
            name: 'assess_edit_task',
            description: 'Edit task content in Assess realm (taskName, priority).',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task to edit' },
                taskName: { type: 'string', description: 'Updated task name/description' },
                taskPriority: { type: 'integer', minimum: 1, maximum: 5, description: 'Updated task priority (1-5)'},
              },
              required: ['taskRecordName']
            }
          },
          {
            name: 'assess_create_project',
            description: 'Create a new project in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                projectName: { type: 'string', description: 'Project name/description (max 1500 chars)' },
                startDate: { type: 'string', format: 'date-time', description: 'Optional start date (ISO format)' },
                collectionRecordName: { type: 'string', description: 'Optional recordName of the parent collection.' }
              },
              required: ['projectName']
            }
          },
          {
            name: 'assess_create_idea',
            description: 'Capture a new idea (always starts in Assess realm).',
            inputSchema: {
              type: 'object',
              properties: {
                ideaName: { type: 'string', description: 'Idea name/details (max 1500 chars)' },
                collectionRecordName: { type: 'string', description: 'Optional recordName of the parent collection.' }
              },
              required: ['ideaName']
            }
          },
          {
            name: 'assess_create_collection',
            description: 'Create a new collection in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                collectionName: { type: 'string', description: 'Collection name' }
              },
              required: ['collectionName']
            }
          },
          {
            name: 'assess_create_context',
            description: 'Create a new context in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                contextName: { type: 'string', description: 'Context name (max 30 chars)' }
              },
              required: ['contextName']
            }
          },
          {
            name: 'assess_edit_project',
            description: 'Edit project content in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                projectRecordName: { type: 'string', description: 'Record name of the project to edit' },
                projectName: { type: 'string', description: 'Updated project name' }
              },
              required: ['projectRecordName']
            }
          },
          {
            name: 'assess_edit_idea',
            description: 'Edit idea content in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                ideaRecordName: { type: 'string', description: 'Record name of the idea to edit' },
                ideaName: { type: 'string', description: 'Updated idea name' }
              },
              required: ['ideaRecordName']
            }
          },
          {
            name: 'assess_add_task_to_project',
            description: 'Add an existing task to a project in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task' },
                projectRecordName: { type: 'string', description: 'Record name of the project' }
              },
              required: ['taskRecordName', 'projectRecordName']
            }
          },
          {
            name: 'assess_add_task_to_idea',
            description: 'Add an existing task to an idea in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task' },
                ideaRecordName: { type: 'string', description: 'Record name of the idea' }
              },
              required: ['taskRecordName', 'ideaRecordName']
            }
          },
          {
            name: 'assess_remove_task_from_project',
            description: 'Remove a task from a project in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task' },
                projectRecordName: { type: 'string', description: 'Record name of the project' }
              },
              required: ['taskRecordName', 'projectRecordName']
            }
          },
          {
            name: 'assess_remove_task_from_idea',
            description: 'Remove a task from an idea in Assess realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task' },
                ideaRecordName: { type: 'string', description: 'Record name of the idea' }
              },
              required: ['taskRecordName', 'ideaRecordName']
            }
          },
          {
            name: 'assess_archive_task_to_collection',
            description: 'Archive a task to a collection.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task' },
                collectionRecordName: { type: 'string', description: 'Record name of the collection' }
              },
              required: ['taskRecordName', 'collectionRecordName']
            }
          },
          {
            name: 'assess_archive_project_to_collection',
            description: 'Archive a project to a collection.',
            inputSchema: {
              type: 'object',
              properties: {
                projectRecordName: { type: 'string', description: 'Record name of the project' },
                collectionRecordName: { type: 'string', description: 'Record name of the collection' }
              },
              required: ['projectRecordName', 'collectionRecordName']
            }
          },

          // Decide Realm Tools (realmId 2)
          {
            name: 'decide_assign_context',
            description: 'Assign contexts to tasks/projects in Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                itemRecordName: { type: 'string', description: 'Record name of the task or project' },
                itemType: { type: 'string', enum: ['Task', 'Project'], description: 'Type of item (Task or Project)' },
                contextRecordName: { type: 'string', description: 'Record name of the context to assign' }
              },
              required: ['itemRecordName', 'itemType', 'contextRecordName']
            }
          },
          {
            name: 'decide_set_project_interval',
            description: 'Set project interval (start date and end date) in Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                projectRecordName: { type: 'string', description: 'Record name of the project' },
                startDate: { type: 'string', format: 'date-time', description: 'Start date in ISO format' },
                endDate: { type: 'string', format: 'date-time', description: 'End date in ISO format' }
              },
              required: ['projectRecordName', 'startDate', 'endDate']
            }
          },
          {
            name: 'decide_set_task_due_date',
            description: 'Set due date for a task in Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Record name of the task' },
                endDate: { type: 'string', format: 'date-time', description: 'Due date in ISO format' }
              },
              required: ['taskRecordName', 'endDate']
            }
          },
          {
            name: 'decide_set_task_alert',
            description: 'Set task alerts in Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Task record name' },
                alertDateTime: { type: 'string', format: 'date-time', description: 'Alert date and time in ISO format for localNotification' }
              },
              required: ['taskRecordName', 'alertDateTime']
            }
          },
          {
            name: 'decide_move_task_to_do',
            description: 'Move task to Do realm from Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Task record name' }
              },
              required: ['taskRecordName']
            }
          },
          {
            name: 'decide_move_task_to_assess_from_decide',
            description: 'Move task to Assess realm from Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Task record name' }
              },
              required: ['taskRecordName']
            }
          },
          {
            name: 'decide_move_project_to_do',
            description: 'Move project to Do realm from Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                projectRecordName: { type: 'string', description: 'Project record name' }
              },
              required: ['projectRecordName']
            }
          },
          {
            name: 'decide_move_project_to_assess_from_decide',
            description: 'Move project to Assess realm from Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                projectRecordName: { type: 'string', description: 'Project record name' }
              },
              required: ['projectRecordName']
            }
          },

          // Do Realm Tools (realmId 3)
          {
            name: 'do_mark_task_as_done',
            description: 'Mark tasks as completed in Do realm.',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Task record name' }
              },
              required: ['taskRecordName']
            }
          },
          {
            name: 'do_mark_project_as_done',
            description: 'Mark projects as completed in Do realm.',
            inputSchema: {
              type: 'object',
              properties: {
                projectRecordName: { type: 'string', description: 'Project record name' }
              },
              required: ['projectRecordName']
            }
          },

          // General Query Tools
          {
            name: 'get_tasks_by_realm',
            description: 'Filter tasks by realm.',
            inputSchema: {
              type: 'object',
              properties: {
                realm: { type: 'string', enum: ['assess', 'decide', 'do'], description: 'Realm to query (maps to realmId 1, 2, or 3)' }
              },
              required: ['realm']
            }
          },
          {
            name: 'get_projects_by_realm',
            description: 'Filter projects by realm.',
            inputSchema: {
              type: 'object',
              properties: {
                realm: { type: 'string', enum: ['assess', 'decide', 'do'], description: 'Realm to query (maps to realmId 1, 2, or 3)' }
              },
              required: ['realm']
            }
          },
          {
            name: 'get_ideas',
            description: 'Get all ideas.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'moveToRealm',
            description: 'Move a task or project to a specific realm.',
            inputSchema: {
              type: 'object',
              properties: {
                itemRecordName: { type: 'string', description: 'Record name of the task or project to move' },
                itemType: { type: 'string', enum: ['Task', 'Project'], description: 'Type of item to move' },
                realmId: { type: 'string', enum: ['assess', 'decide', 'do'], description: 'Target realm (assess=1, decide=2, do=3)' }
              },
              required: ['itemRecordName', 'itemType', 'realmId']
            }
          },
          {
            name: 'get_collections',
            description: 'Get all collections.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_tasks_by_context',
            description: 'Filter by context.',
            inputSchema: {
              type: 'object',
              properties: {
                contextRecordName: { type: 'string', description: 'Record name of the context to filter by' }
              },
              required: ['contextRecordName']
            }
          },
          {
            name: 'get_stalled_items_in_decide',
            description: 'Find stalled items (tasks + projects) in Decide realm.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_undecided_items_in_decide',
            description: 'Find undecided items (tasks + projects) in Decide realm.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_ready_items_in_decide',
            description: 'Find ready to do items (tasks + projects) in Decide realm.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_tasks_today_in_do',
            description: 'Find tasks due today in Do realm.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_tasks_tomorrow_in_do',
            description: 'Find tasks due tomorrow in Do realm.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_tasks_soon_in_do',
            description: 'Find tasks due soon in Do realm.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_tasks_overdue_in_do',
            description: 'Find tasks overdue in Do realm.',
            inputSchema: { type: 'object', properties: {} }
          }
        ] as Tool[]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: argsAny } = request.params;
      const args = argsAny as any; // Simplify arg access for now

      try {
        if (name !== 'authenticate_user' && !this.userToken) {
          throw new McpError(ErrorCode.InvalidRequest, 'User must be authenticated. Call authenticate_user first.');
        }

        switch (name) {
          case 'authenticate_user':
            if (!args || typeof args.webAuthToken !== 'string') {
              throw new McpError(ErrorCode.InvalidRequest, 'Invalid or missing webAuthToken.');
            }
            return await this.authenticateUser(args.webAuthToken);

          // Assess Realm Operations
          case 'assess_create_task':
            this.validateArgs(args, ['taskName']);
            return await this.createTask(args.taskName, args.startDate, args.taskPriority, args.projectRecordName, args.collectionRecordName);
          case 'assess_edit_task':
            this.validateArgs(args, ['taskRecordName']);
            return await this.editTask(args.taskRecordName, args.taskName, args.taskPriority);
          case 'assess_create_project':
            this.validateArgs(args, ['projectName']);
            return await this.createProject(args.projectName, args.startDate, args.collectionRecordName);
          case 'assess_edit_project':
            this.validateArgs(args, ['projectRecordName']);
            return await this.editProject(args.projectRecordName, args.projectName);
          case 'assess_create_idea':
            this.validateArgs(args, ['ideaName']);
            return await this.createIdea(args.ideaName, args.collectionRecordName);
          case 'assess_edit_idea':
            this.validateArgs(args, ['ideaRecordName']);
            return await this.editIdea(args.ideaRecordName, args.ideaName);
          case 'assess_create_collection':
            this.validateArgs(args, ['collectionName']);
            return await this.createCollection(args.collectionName);
          case 'assess_create_context':
            this.validateArgs(args, ['contextName']);
            return await this.createContext(args.contextName);
          case 'assess_add_task_to_project':
            this.validateArgs(args, ['taskRecordName', 'projectRecordName']);
            return await this.addTaskToProject(args.taskRecordName, args.projectRecordName);
          case 'assess_add_task_to_idea':
            this.validateArgs(args, ['taskRecordName', 'ideaRecordName']);
            return await this.addTaskToIdea(args.taskRecordName, args.ideaRecordName);
          case 'assess_remove_task_from_project':
            this.validateArgs(args, ['taskRecordName', 'projectRecordName']);
            return await this.removeTaskFromProject(args.taskRecordName, args.projectRecordName);
          case 'assess_remove_task_from_idea':
            this.validateArgs(args, ['taskRecordName', 'ideaRecordName']);
            return await this.removeTaskFromIdea(args.taskRecordName, args.ideaRecordName);
          case 'assess_archive_task_to_collection':
            this.validateArgs(args, ['taskRecordName', 'collectionRecordName']);
            return await this.archiveTaskToCollection(args.taskRecordName, args.collectionRecordName);
          case 'assess_archive_project_to_collection':
            this.validateArgs(args, ['projectRecordName', 'collectionRecordName']);
            return await this.archiveProjectToCollection(args.projectRecordName, args.collectionRecordName);

          // Decide Realm Operations
          case 'decide_assign_context':
            this.validateArgs(args, ['itemRecordName', 'itemType', 'contextRecordName']);
            if (!['Task', 'Project'].includes(args.itemType)) {
                throw new McpError(ErrorCode.InvalidParams, "itemType must be 'Task' or 'Project'.");
            }
            return await this.assignContextToItem(args.itemRecordName, args.itemType as 'Task' | 'Project', args.contextRecordName);
          case 'decide_set_project_interval':
            this.validateArgs(args, ['projectRecordName', 'startDate', 'endDate']);
            return await this.setProjectInterval(args.projectRecordName, args.startDate, args.endDate);
          case 'decide_set_task_due_date':
            this.validateArgs(args, ['taskRecordName', 'endDate']);
            return await this.setTaskDueDate(args.taskRecordName, args.endDate);
          case 'decide_set_task_alert':
            this.validateArgs(args, ['taskRecordName', 'alertDateTime']);
            return await this.setTaskAlert(args.taskRecordName, args.alertDateTime);
          case 'decide_move_task_to_do':
            this.validateArgs(args, ['taskRecordName']);
            return await this.moveTaskToRealm(args.taskRecordName, 'do');
          case 'decide_move_task_to_assess_from_decide':
            this.validateArgs(args, ['taskRecordName']);
            return await this.moveTaskToRealm(args.taskRecordName, 'assess');
          case 'decide_move_project_to_do':
            this.validateArgs(args, ['projectRecordName']);
            return await this.moveProjectToRealm(args.projectRecordName, 'do');
          case 'decide_move_project_to_assess_from_decide':
            this.validateArgs(args, ['projectRecordName']);
            return await this.moveProjectToRealm(args.projectRecordName, 'assess');

          // Do Realm Operations
          case 'do_mark_task_as_done':
            this.validateArgs(args, ['taskRecordName']);
            return await this.markTaskAsDone(args.taskRecordName);
          case 'do_mark_project_as_done':
            this.validateArgs(args, ['projectRecordName']);
            return await this.markProjectAsDone(args.projectRecordName);

          // Query Operations
          case 'get_tasks_by_realm':
            this.validateArgs(args, ['realm']);
            return await this.getTasksByRealm(args.realm as RealmString);
          case 'get_projects_by_realm':
            this.validateArgs(args, ['realm']);
            return await this.getProjectsByRealm(args.realm as RealmString);
          case 'get_ideas':
            return await this.getIdeas();
          case 'moveToRealm':
            this.validateArgs(args, ['itemRecordName', 'itemType', 'realmId']);
            if (args.itemType === 'Task') {
              return await this.moveTaskToRealm(args.itemRecordName, args.realmId);
            } else if (args.itemType === 'Project') {
              return await this.moveProjectToRealm(args.itemRecordName, args.realmId);
            } else {
              throw new McpError(ErrorCode.InvalidParams, 'itemType must be Task or Project');
            }
          case 'get_collections':
            return await this.getCollections();
          case 'get_tasks_by_context':
            this.validateArgs(args, ['contextRecordName']);
            return await this.getTasksByContext(args.contextRecordName);
          case 'get_stalled_items_in_decide':
            return await this.getStalledItemsInDecide();
          case 'get_undecided_items_in_decide':
            return await this.getUndecidedItemsInDecide();
          case 'get_ready_items_in_decide':
            return await this.getReadyItemsInDecide();
          case 'get_tasks_today_in_do':
            return await this.getTasksTodayInDo();
          case 'get_tasks_tomorrow_in_do':
            return await this.getTasksTomorrowInDo();
          case 'get_tasks_soon_in_do':
            return await this.getTasksSoonInDo();
          case 'get_tasks_overdue_in_do':
            return await this.getTasksOverdueInDo();

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        console.error(`Tool execution failed for ${name}:`, error);
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private validateArgs(args: any, required: string[]) {
    if (!args) throw new McpError(ErrorCode.InvalidParams, 'Arguments are missing.');
    for (const req of required) {
      if (!(req in args) || args[req] === undefined || args[req] === null || args[req] === '') {
        throw new McpError(ErrorCode.InvalidParams, `Missing required argument: ${req}.`);
      }
    }
  }

  // --- Mock CloudKit Interaction Layer ---
  // In a real app, these would interact with CloudKit.js SDK
  // For now, they return mock data or success messages.

  // ==================== CLOUDKIT PRODUCTION METHODS ====================
  
  async initializeCloudKit(): Promise<void> {
    try {
      // Try to load CloudKit services dynamically (only in production)
      if (process.env.NODE_ENV === 'production' || process.env.FORCE_CLOUDKIT === 'true') {
        const { getCloudKitConfig, getSecurityConfig } = await import('./config/production');
        const { CloudKitService } = await import('./services/CloudKitService');
        const { UserAuthService, AuthMiddleware } = await import('./services/UserAuthService');
        
        const cloudKitConfig = getCloudKitConfig();
        const securityConfig = getSecurityConfig();

        // Initialize CloudKit service
        this.cloudKitService = new CloudKitService();
        await this.cloudKitService.initialize(cloudKitConfig);

        // Initialize authentication service
        this.authService = new UserAuthService(this.cloudKitService, securityConfig);
        this.authMiddleware = new AuthMiddleware(this.authService);
        
        this.productionMode = true;
        console.error(`🚀 CloudKit production mode initialized for container: ${cloudKitConfig.containerID} (${cloudKitConfig.environment})`);
        
      } else {
        console.error('📝 Running in development mode with mock CloudKit implementation');
      }
    } catch (error) {
      console.warn('CloudKit initialization failed, using mock implementation:', error);
      this.productionMode = false;
    }
  }

  private async authenticateUser(webAuthToken: string) {
    if (this.productionMode && this.authService) {
      // Production CloudKit authentication
      try {
        const authResult = await this.authService.authenticateUser(webAuthToken);
        
        if (authResult.success) {
          this.currentSession = await this.authService.validateSession(authResult.sessionId!);
          this.userToken = {
            cloudKitWebAuthToken: webAuthToken,
            userIdentity: { 
              userRecordName: authResult.userRecordName, 
              lookupInfo: { sessionId: authResult.sessionId } 
            }
          };
          
          return { 
            content: [{ 
              type: 'text', 
              text: `✅ Successfully authenticated with iCloud as ${authResult.userRecordName}. Session expires: ${authResult.expiresAt?.toLocaleString()}` 
            }] 
          };
        } else if (authResult.redirectToSignIn) {
          return { 
            content: [{ 
              type: 'text', 
              text: `🔐 Please authenticate with your Apple ID: ${authResult.authUrl}\n\nAfter signing in, provide your web auth token to complete authentication.` 
            }] 
          };
        } else {
          throw new Error(authResult.message || 'Authentication failed');
        }
      } catch (error) {
        console.error('Production CloudKit authentication failed:', error);
        throw new McpError(ErrorCode.InvalidParams, `CloudKit authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      // Mock authentication for development
      this.userToken = {
        cloudKitWebAuthToken: webAuthToken,
        userIdentity: { userRecordName: `mock_user_${uuidv4()}`, lookupInfo: {} }
      };
      return { content: [{ type: 'text', text: '🧪 Mock authentication successful. You can now access addTaskManager data (development mode).' }] };
    }
  }

  private async validateAuthentication(): Promise<void> {
    if (this.productionMode && this.authMiddleware && this.currentSession) {
      // Validate session in production
      const validation = await this.authMiddleware.validateRequest(this.currentSession.sessionId);
      if (!validation.valid) {
        this.currentSession = null;
        this.userToken = null;
        throw new McpError(ErrorCode.InvalidParams, validation.error || 'Session expired. Please re-authenticate.');
      }
    } else if (!this.userToken) {
      // Basic check for mock mode
      throw new McpError(ErrorCode.InvalidParams, 'Not authenticated. Please call authenticate_user first.');
    }
  }

  private async withCloudKitOrMock<T>(
    operation: string,
    cloudKitOperation: () => Promise<T>,
    mockOperation: () => Promise<T>
  ): Promise<T> {
    await this.validateAuthentication();
    
    if (this.productionMode && this.cloudKitService) {
      try {
        console.error(`🔄 CloudKit operation: ${operation}`);
        return await cloudKitOperation();
      } catch (error) {
        console.error(`CloudKit operation failed (${operation}):`, error);
        // Fall back to mock if CloudKit fails
        console.error(`🧪 Falling back to mock operation for: ${operation}`);
        return await mockOperation();
      }
    } else {
      return await mockOperation();
    }
  }

  // Assess Realm
  private async createTask(taskName: string, startDateISO?: string, taskPriority: number = 3, projectRecordName?: string, collectionRecordName?: string) {
    const now = Date.now();
    const taskRecordName = `task_ck_${uuidv4()}`;
    const task: ZenTaskticTask = {
      recordType: 'Task',
      recordName: taskRecordName,
      fields: {
        taskName: { value: taskName },
        realmId: { value: REALM_ASSESS_ID },
        uniqueId: { value: uuidv4() },
        startDate: { value: startDateISO ? new Date(startDateISO).getTime() : now },
        lastModified: { value: now },
        taskPriority: { value: taskPriority },
        ...(projectRecordName && { project: { value: { recordName: projectRecordName, action: 'NONE' } } }),
        ...(collectionRecordName && { collection: { value: { recordName: collectionRecordName, action: 'NONE' } } }),
      }
    };
    // Mock save: console.log('Mock CloudKit: Creating Task', task);
    return { content: [{ type: 'text', text: `Task "${taskName}" created in Assess realm with ID ${taskRecordName}.` }] };
  }

  private async editTask(taskRecordName: string, taskName?: string, taskPriority?: number) {
    // Mock fetch & check realm (should be REALM_ASSESS_ID)
    // Mock update: console.log('Mock CloudKit: Editing Task', taskRecordName, { taskName, taskPriority });
    let updateMsg = `Task ${taskRecordName} updated.`;
    if (taskName) updateMsg += ` Name set to "${taskName}".`;
    if (taskPriority) updateMsg += ` Priority set to ${taskPriority}.`;
    return { content: [{ type: 'text', text: updateMsg }] };
  }

  private async createProject(projectName: string, startDateISO?: string, collectionRecordName?: string) {
    const now = Date.now();
    const projectRecordName = `project_ck_${uuidv4()}`;
    const project: ZenTaskticProject = {
      recordType: 'Projects',
      recordName: projectRecordName,
      fields: {
        projectName: { value: projectName },
        realmId: { value: REALM_ASSESS_ID },
        uniqueId: { value: uuidv4() },
        startDate: { value: startDateISO ? new Date(startDateISO).getTime() : now },
        lastModified: { value: now },
        ...(collectionRecordName && { collection: { value: { recordName: collectionRecordName, action: 'NONE' } } }),
      }
    };
    // Mock save: console.log('Mock CloudKit: Creating Project', project);
    return { content: [{ type: 'text', text: `Project "${projectName}" created in Assess realm with ID ${projectRecordName}.` }] };
  }

  private async createIdea(ideaName: string, collectionRecordName?: string) {
    const now = Date.now();
    const ideaRecordName = `idea_ck_${uuidv4()}`;
    const idea: ZenTaskticIdea = {
      recordType: 'Ideas',
      recordName: ideaRecordName,
      fields: {
        ideaName: { value: ideaName },
        realmId: { value: REALM_ASSESS_ID }, // Ideas always start in Assess
        uniqueId: { value: uuidv4() },
        lastModified: { value: now },
        ...(collectionRecordName && { collection: { value: { recordName: collectionRecordName, action: 'NONE' } } }),
      }
    };
    // Mock save: console.log('Mock CloudKit: Creating Idea', idea);
    return { content: [{ type: 'text', text: `Idea "${ideaName}" captured in Assess realm with ID ${ideaRecordName}.` }] };
  }

  // Decide Realm
  private async assignContextToItem(itemRecordName: string, itemType: 'Task' | 'Project', contextRecordName: string) {
    // Validate that item is in Decide realm before assigning context
    const item = await this.mockFetchItem(itemRecordName, itemType);
    if (!item) {
      throw new McpError(ErrorCode.InvalidParams, `${itemType} ${itemRecordName} not found`);
    }
    if (item.realmId !== REALM_DECIDE_ID) {
      throw new McpError(ErrorCode.InvalidParams, `${itemType} ${itemRecordName} must be in Decide realm to assign context. Current realm: ${item.realmId}`);
    }
    
    // Mock update: console.log('Mock CloudKit: Assigning context', contextRecordName, 'to', itemType, itemRecordName);
    return { content: [{ type: 'text', text: `Context ${contextRecordName} assigned to ${itemType} ${itemRecordName} in Decide realm.` }] };
  }

  private async setDueDateForItem(itemRecordName: string, itemType: 'Task' | 'Project', endDateISO: string) {
    // Mock fetch & check realm (should be REALM_DECIDE_ID)
    const endDateTimestamp = new Date(endDateISO).getTime();
    // Mock update: console.log('Mock CloudKit: Setting endDate', endDateTimestamp, 'for', itemType, itemRecordName);
    return { content: [{ type: 'text', text: `Due date (endDate) ${endDateISO} set for ${itemType} ${itemRecordName} in Decide realm.` }] };
  }

  private async setAlertForTask(taskRecordName: string, alertDateTimeISO: string) {
    // Mock fetch & check realm (should be REALM_DECIDE_ID)
    // Mock update: console.log('Mock CloudKit: Setting localNotification', alertDateTimeISO, 'for Task', taskRecordName);
    return { content: [{ type: 'text', text: `Alert at ${alertDateTimeISO} set for Task ${taskRecordName} in Decide realm.` }] };
  }

  // Method aliases to match switch statement calls
  private async setProjectInterval(projectRecordName: string, startDate: string, endDate: string) {
    return this.setDueDateForItem(projectRecordName, 'Project', endDate);
  }

  private async setTaskDueDate(taskRecordName: string, endDate: string) {
    // Validate that task is in Decide realm before setting due date
    const item = await this.mockFetchItem(taskRecordName, 'Task');
    if (!item) {
      throw new McpError(ErrorCode.InvalidParams, `Task ${taskRecordName} not found`);
    }
    if (item.realmId !== REALM_DECIDE_ID) {
      throw new McpError(ErrorCode.InvalidParams, `Task ${taskRecordName} must be in Decide realm to set due date. Current realm: ${item.realmId}`);
    }
    
    // Validate due date is in the future
    const dueDate = new Date(endDate);
    const now = new Date();
    if (dueDate <= now) {
      throw new McpError(ErrorCode.InvalidParams, `Due date must be in the future. Provided: ${dueDate.toLocaleDateString()}`);
    }
    
    return this.setDueDateForItem(taskRecordName, 'Task', endDate);
  }

  private async setTaskAlert(taskRecordName: string, alertDateTime: string) {
    return this.setAlertForTask(taskRecordName, alertDateTime);
  }

  private async moveTaskToRealm(taskRecordName: string, targetRealm: string) {
    // Add validation before moving
    const validationResult = await this.validateRealmTransition(taskRecordName, 'Task', targetRealm as RealmString);
    if (!validationResult.valid) {
      throw new McpError(ErrorCode.InvalidParams, validationResult.reason);
    }
    return this.moveItemToRealm(taskRecordName, 'Task', targetRealm as RealmString);
  }

  private async moveProjectToRealm(projectRecordName: string, targetRealm: string) {
    // Add validation before moving
    const validationResult = await this.validateRealmTransition(projectRecordName, 'Project', targetRealm as RealmString);
    if (!validationResult.valid) {
      throw new McpError(ErrorCode.InvalidParams, validationResult.reason);
    }
    return this.moveItemToRealm(projectRecordName, 'Project', targetRealm as RealmString);
  }

  // ==================== ADD FRAMEWORK VALIDATION LOGIC ====================
  private async validateRealmTransition(itemRecordName: string, itemType: 'Task' | 'Project', targetRealm: RealmString): Promise<{valid: boolean, reason: string}> {
    // Mock fetch current item data
    const currentItem = await this.mockFetchItem(itemRecordName, itemType);
    
    if (!currentItem) {
      return { valid: false, reason: `${itemType} ${itemRecordName} not found` };
    }

    const currentRealmId = currentItem.realmId;
    const targetRealmId = realmStringToId(targetRealm);
    
    // Validate transition rules based on ADD framework
    switch (currentRealmId) {
      case REALM_ASSESS_ID: // From Assess (1)
        return this.validateFromAssess(currentItem, targetRealmId, itemType);
      
      case REALM_DECIDE_ID: // From Decide (2)
        return this.validateFromDecide(currentItem, targetRealmId, itemType);
      
      case REALM_DO_ID: // From Do (3)
        return this.validateFromDo(currentItem, targetRealmId, itemType);
      
      default:
        return { valid: false, reason: `Invalid current realm ID: ${currentRealmId}` };
    }
  }

  private validateFromAssess(item: any, targetRealmId: number, itemType: string): {valid: boolean, reason: string} {
    switch (targetRealmId) {
      case REALM_DECIDE_ID: // Assess -> Decide
        // Valid transition: Items naturally progress from Assess to Decide
        return { valid: true, reason: 'Valid progression from Assess to Decide realm' };
      
      case REALM_DO_ID: // Assess -> Do (skip Decide)
        // Allow but warn: Items can skip Decide if they're simple and fully defined
        return { 
          valid: true, 
          reason: `${itemType} moved directly from Assess to Do (skipping Decide) - ensure context and due date are set` 
        };
      
      case REALM_ASSESS_ID: // Assess -> Assess
        return { valid: false, reason: `${itemType} is already in Assess realm` };
      
      default:
        return { valid: false, reason: `Invalid target realm ID: ${targetRealmId}` };
    }
  }

  private validateFromDecide(item: any, targetRealmId: number, itemType: string): {valid: boolean, reason: string} {
    switch (targetRealmId) {
      case REALM_DO_ID: // Decide -> Do
        // Must have context and due date to move to Do
        if (!item.contextRecordName) {
          return { valid: false, reason: `${itemType} must have a context assigned before moving to Do realm` };
        }
        if (!item.endDate) {
          return { valid: false, reason: `${itemType} must have a due date set before moving to Do realm` };
        }
        
        // Check if due date is in the future (not stalled)
        const now = new Date();
        const dueDate = new Date(item.endDate);
        if (dueDate < now) {
          return { 
            valid: false, 
            reason: `${itemType} has a past due date (${dueDate.toLocaleDateString()}) - update due date or move back to Assess` 
          };
        }
        
        return { valid: true, reason: `${itemType} ready for Do realm - context and future due date set` };
      
      case REALM_ASSESS_ID: // Decide -> Assess (backward)
        // Allow backward movement for re-evaluation
        return { 
          valid: true, 
          reason: `${itemType} moved back to Assess realm for re-evaluation - context and due date will be cleared` 
        };
      
      case REALM_DECIDE_ID: // Decide -> Decide
        return { valid: false, reason: `${itemType} is already in Decide realm` };
      
      default:
        return { valid: false, reason: `Invalid target realm ID: ${targetRealmId}` };
    }
  }

  private validateFromDo(item: any, targetRealmId: number, itemType: string): {valid: boolean, reason: string} {
    switch (targetRealmId) {
      case REALM_ASSESS_ID: // Do -> Assess
        // Allow if item needs major re-evaluation
        return { 
          valid: true, 
          reason: `${itemType} moved back to Assess realm - will be cleared of context and due date for fresh evaluation` 
        };
      
      case REALM_DECIDE_ID: // Do -> Decide 
        // Allow if item needs rescheduling/context change but not major re-evaluation
        return { 
          valid: true, 
          reason: `${itemType} moved back to Decide realm for rescheduling or context adjustment` 
        };
      
      case REALM_DO_ID: // Do -> Do
        return { valid: false, reason: `${itemType} is already in Do realm` };
      
      default:
        return { valid: false, reason: `Invalid target realm ID: ${targetRealmId}` };
    }
  }

  // Mock data fetcher for validation - in real implementation this would query CloudKit
  private async mockFetchItem(itemRecordName: string, itemType: 'Task' | 'Project'): Promise<any> {
    // Mock different scenarios based on record name patterns
    const baseItem = {
      recordName: itemRecordName,
      type: itemType,
      lastModified: new Date().toISOString()
    };

    // Simulate different states for validation testing
    if (itemRecordName.includes('assess')) {
      return { ...baseItem, realmId: REALM_ASSESS_ID, contextRecordName: null, endDate: null };
    } else if (itemRecordName.includes('undecided')) {
      return { ...baseItem, realmId: REALM_DECIDE_ID, contextRecordName: null, endDate: null };
    } else if (itemRecordName.includes('stalled')) {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      return { ...baseItem, realmId: REALM_DECIDE_ID, contextRecordName: 'context_work', endDate: yesterday };
    } else if (itemRecordName.includes('ready')) {
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      return { ...baseItem, realmId: REALM_DECIDE_ID, contextRecordName: 'context_work', endDate: tomorrow };
    } else if (itemRecordName.includes('do')) {
      const today = new Date().toISOString();
      return { ...baseItem, realmId: REALM_DO_ID, contextRecordName: 'context_work', endDate: today };
    } else {
      // Default to Assess realm item
      return { ...baseItem, realmId: REALM_ASSESS_ID, contextRecordName: null, endDate: null };
    }
  }

  private async moveItemToRealm(itemRecordName: string, itemType: 'Task' | 'Project', targetRealmStr: RealmString) {
    const targetRealmId = realmStringToId(targetRealmStr);
    
    // Mock update realmId and clean up fields based on realm rules
    let updateMessage = `${itemType} ${itemRecordName} moved to ${targetRealmStr} realm (ID: ${targetRealmId})`;
    
    // Apply realm-specific cleanup rules
    if (targetRealmId === REALM_ASSESS_ID) {
      updateMessage += '. Context and due date cleared for fresh evaluation';
    } else if (targetRealmId === REALM_DECIDE_ID && targetRealmStr !== 'decide') {
      updateMessage += '. Ready for context assignment and due date setting';
    }
    
    return { content: [{ type: 'text', text: updateMessage }] };
  }

  // Do Realm
  private async completeTask(taskRecordName: string) {
    // Mock fetch & check realm (should be REALM_DO_ID)
    const completionTime = new Date().toISOString();
    // Mock update endDate: console.log('Mock CloudKit: Completing Task', taskRecordName, 'at', completionTime);
    return { content: [{ type: 'text', text: `Task ${taskRecordName} marked as completed at ${completionTime} in Do realm (endDate set).` }] };
  }

  private async completeProject(projectRecordName: string) {
    // Mock fetch & check realm (should be REALM_DO_ID)
    const completionTime = new Date().toISOString();
    // Mock update endDate: console.log('Mock CloudKit: Completing Project', projectRecordName, 'at', completionTime);
    return { content: [{ type: 'text', text: `Project ${projectRecordName} marked as completed at ${completionTime} in Do realm (endDate set).` }] };
  }

  // Query Operations
  private async getItemsByRealm(realmStr: RealmString) {
    const realmId = realmStringToId(realmStr);
    // Mock query: console.log('Mock CloudKit: Fetching items for realmId', realmId);
    const mockTasks = [{ recordName: 'task_123', taskName: 'Sample Task A', realmId }];
    const mockProjects = [{ recordName: 'project_456', projectName: 'Sample Project X', realmId }];
    let response = `Items in ${realmStr} realm (ID: ${realmId}):\n`;
    response += `Tasks:\n${mockTasks.map(t => `- ${t.taskName} (${t.recordName})`).join('\n')}\n`;
    response += `Projects:\n${mockProjects.map(p => `- ${p.projectName} (${p.recordName})`).join('\n')}`;
    return { content: [{ type: 'text', text: response }] };
  }

  private async getIdeas() {
    return this.withCloudKitOrMock(
      'getIdeas',
      async () => {
        // CloudKit production implementation
        const ideas = await this.cloudKitService.getIdeas();
        
        let response = `All ideas:\n`;
        if (ideas.length === 0) {
          response += 'No ideas found. Time to brainstorm! 💡';
        } else {
          response += ideas.map((idea: any) => {
            const name = idea.fields?.ideaName?.value || 'Unnamed Idea';
            const realmId = idea.fields?.realmId?.value || 1;
            const realmName = realmId === 1 ? 'Assess' : 'Unknown';
            
            return `- ${name} (${idea.recordName}) [${realmName}]`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const mockIdeas = [{ recordName: 'idea_789', ideaName: 'Brilliant Idea Z' }];
        return { content: [{ type: 'text', text: `Found ${mockIdeas.length} ideas:\n${mockIdeas.map(i => `- ${i.ideaName} (${i.recordName})`).join('\n')}` }] };
      }
    );
  }

  private async getTasksByContext(contextRecordName: string) {
    return this.withCloudKitOrMock(
      'getTasksByContext',
      async () => {
        // CloudKit production implementation
        const tasks = await this.cloudKitService.getTasksByContext(contextRecordName);
        
        let response = `Tasks for context ${contextRecordName}:\n`;
        if (tasks.length === 0) {
          response += 'No tasks found for this context. 📋';
        } else {
          response += tasks.map((task: any) => {
            const name = task.fields?.taskName?.value || 'Unnamed Task';
            const realmId = task.fields?.realmId?.value || 1;
            const realmName = realmId === 1 ? 'Assess' : realmId === 2 ? 'Decide' : realmId === 3 ? 'Do' : 'Unknown';
            const priority = task.fields?.taskPriority?.value || 3;
            const priorityIcon = priority === 1 ? '🔴' : priority === 2 ? '🟡' : '🟢';
            
            return `- ${name} (${task.recordName}) [${realmName}] ${priorityIcon}`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const mockTasks = [{ recordName: 'task_abc', taskName: 'Task with specific context' }];
        return { content: [{ type: 'text', text: `Found ${mockTasks.length} tasks for context ${contextRecordName}:\n${mockTasks.map(t => `- ${t.taskName} (${t.recordName})`).join('\n')}` }] };
      }
    );
  }

  private async getOverdueTasks() {
    // Mock query: tasks where endDate < now AND (e.g. realmId IS REALM_DO_ID or not yet marked explicitly 'done' if there was a separate status)
    // console.log('Mock CloudKit: Fetching overdue tasks');
    const mockOverdue = [{ recordName: 'task_def', taskName: 'Overdue Task Alpha', endDate: new Date(Date.now() - 86400000).toISOString() }];
    return { content: [{ type: 'text', text: `Found ${mockOverdue.length} overdue tasks:\n${mockOverdue.map(t => `- ${t.taskName} (${t.recordName}), due: ${t.endDate}`).join('\n')}` }] };
  }

  // ==================== MISSING METHOD IMPLEMENTATIONS ====================
  // These methods correspond to the tools added in the switch statement

  // ASSESS REALM METHODS
  private async editProject(projectRecordName: string, projectName: string) {
    // Mock project edit via CloudKit
    return { content: [{ type: 'text', text: `Project ${projectRecordName} updated with name: ${projectName}` }] };
  }

  private async editIdea(ideaRecordName: string, ideaName: string) {
    // Mock idea edit via CloudKit
    return { content: [{ type: 'text', text: `Idea ${ideaRecordName} updated with name: ${ideaName}` }] };
  }

  private async createCollection(collectionName: string) {
    const recordName = `collection_${uuidv4()}`;
    // Mock collection creation via CloudKit
    return { content: [{ type: 'text', text: `Collection "${collectionName}" created with recordName: ${recordName}` }] };
  }

  private async createContext(contextName: string) {
    const recordName = `context_${uuidv4()}`;
    // Mock context creation via CloudKit
    return { content: [{ type: 'text', text: `Context "${contextName}" created with recordName: ${recordName}` }] };
  }

  private async editCollection(args: any) {
    const { recordName, collectionName } = args;
    // Mock collection edit via CloudKit
    return { content: [{ type: 'text', text: `Collection ${recordName} updated with name: ${collectionName}` }] };
  }

  private async editContext(args: any) {
    const { recordName, contextName } = args;
    // Mock context edit via CloudKit
    return { content: [{ type: 'text', text: `Context ${recordName} updated with name: ${contextName}` }] };
  }

  private async addTaskToProject(taskRecordName: string, projectRecordName: string) {
    // Mock adding task to project via CloudKit
    return { content: [{ type: 'text', text: `Task ${taskRecordName} added to project ${projectRecordName}` }] };
  }

  private async addTaskToIdea(taskRecordName: string, ideaRecordName: string) {
    // Mock adding task to idea via CloudKit
    return { content: [{ type: 'text', text: `Task ${taskRecordName} added to idea ${ideaRecordName}` }] };
  }

  private async removeTaskFromProject(taskRecordName: string, projectRecordName: string) {
    // Mock removing task from project via CloudKit
    return { content: [{ type: 'text', text: `Task ${taskRecordName} removed from project ${projectRecordName}` }] };
  }

  private async removeTaskFromIdea(taskRecordName: string, ideaRecordName: string) {
    // Mock removing task from idea via CloudKit
    return { content: [{ type: 'text', text: `Task ${taskRecordName} removed from idea ${ideaRecordName}` }] };
  }

  private async archiveTaskToCollection(taskRecordName: string, collectionRecordName: string) {
    // Mock archiving task to collection via CloudKit
    return { content: [{ type: 'text', text: `Task ${taskRecordName} archived to collection ${collectionRecordName}` }] };
  }

  private async archiveProjectToCollection(projectRecordName: string, collectionRecordName: string) {
    // Mock archiving project to collection via CloudKit
    return { content: [{ type: 'text', text: `Project ${projectRecordName} archived to collection ${collectionRecordName}` }] };
  }

  // Add missing getCollections method
  private async getCollections() {
    return this.withCloudKitOrMock(
      'getCollections',
      async () => {
        // CloudKit production implementation
        const collections = await this.cloudKitService.getCollections();
        
        let response = `All collections:\n`;
        if (collections.length === 0) {
          response += 'No collections found. Create some to organize your tasks! 📋';
        } else {
          response += collections.map((collection: any) => {
            const name = collection.fields?.collectionName?.value || 'Unnamed Collection';
            
            return `- ${name} (${collection.recordName})`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const mockCollections = [
          { recordName: 'collection_1', collectionName: 'Work Projects' },
          { recordName: 'collection_2', collectionName: 'Personal Goals' },
          { recordName: 'collection_3', collectionName: 'Done' }
        ];
        return { content: [{ type: 'text', text: `All collections:\n${mockCollections.map(c => `- ${c.collectionName} (${c.recordName})`).join('\n')}` }] };
      }
    );
  }


  // DO REALM METHODS
  private async markTaskAsDone(taskRecordName: string) {
    // Validate that task is in Do realm before marking as done
    const item = await this.mockFetchItem(taskRecordName, 'Task');
    if (!item) {
      throw new McpError(ErrorCode.InvalidParams, `Task ${taskRecordName} not found`);
    }
    if (item.realmId !== REALM_DO_ID) {
      throw new McpError(ErrorCode.InvalidParams, `Task ${taskRecordName} must be in Do realm to mark as done. Current realm: ${item.realmId}. Move to Do realm first.`);
    }
    
    const completionTime = new Date().toISOString();
    // Mock marking task as done via CloudKit - this would set realmId to 4 (Done) and move to Done collection
    return { content: [{ type: 'text', text: `Task ${taskRecordName} marked as done at ${completionTime}. Moved to Done collection (realm 4).` }] };
  }

  private async markProjectAsDone(projectRecordName: string) {
    // Validate that project is in Do realm before marking as done
    const item = await this.mockFetchItem(projectRecordName, 'Project');
    if (!item) {
      throw new McpError(ErrorCode.InvalidParams, `Project ${projectRecordName} not found`);
    }
    if (item.realmId !== REALM_DO_ID) {
      throw new McpError(ErrorCode.InvalidParams, `Project ${projectRecordName} must be in Do realm to mark as done. Current realm: ${item.realmId}. Move to Do realm first.`);
    }
    
    const completionTime = new Date().toISOString();
    // Mock marking project as done via CloudKit - this would also mark all subtasks as done
    return { content: [{ type: 'text', text: `Project ${projectRecordName} and all subtasks marked as done at ${completionTime}. Moved to Done collection (realm 4).` }] };
  }

  // QUERY METHODS
  private async getTasksByRealm(realm: RealmString) {
    const realmId = realmStringToId(realm);
    const mockTasks = [{ recordName: 'task_123', taskName: 'Sample Task A', realmId }];
    return { content: [{ type: 'text', text: `Tasks in ${realm} realm (ID: ${realmId}):\n${mockTasks.map(t => `- ${t.taskName} (${t.recordName})`).join('\n')}` }] };
  }

  private async getProjectsByRealm(realm: RealmString) {
    const realmId = realmStringToId(realm);
    const mockProjects = [{ recordName: 'project_456', projectName: 'Sample Project X', realmId }];
    return { content: [{ type: 'text', text: `Projects in ${realm} realm (ID: ${realmId}):\n${mockProjects.map(p => `- ${p.projectName} (${p.recordName})`).join('\n')}` }] };
  }

  // Keep existing getIdeas and getCollections methods (they're already implemented above)

  // DECIDE REALM SUBDIVISIONS - Enhanced logic matching iOS app
  private async getStalledItemsInDecide() {
    return this.withCloudKitOrMock(
      'getStalledItemsInDecide',
      async () => {
        // CloudKit production implementation
        const [stalledTasks, stalledProjects] = await Promise.all([
          this.cloudKitService.getTasksInDecideStalled(),
          this.cloudKitService.getProjectsByRealm(2).then((projects: any[]) => 
            projects.filter((project: any) => {
              const endDate = project.fields?.endDate?.value;
              return endDate && new Date(endDate) < new Date();
            })
          )
        ]);

        const allStalledItems = [...stalledTasks, ...stalledProjects];
        const now = new Date();
        
        let response = `Stalled items in Decide realm (past due dates):\n`;
        if (allStalledItems.length === 0) {
          response += 'No stalled items found. Great job staying on track! 🎉';
        } else {
          response += allStalledItems.map(item => {
            const isTask = item.recordType === 'Task';
            const name = isTask ? item.fields?.taskName?.value : item.fields?.projectName?.value;
            const endDate = item.fields?.endDate?.value;
            const daysOverdue = Math.ceil((now.getTime() - new Date(endDate).getTime()) / (24 * 60 * 60 * 1000));
            const type = isTask ? 'Task' : 'Project';
            return `- ${name} (${item.recordName}) - ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} overdue [${type}]`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const now = new Date();
        const yesterday = new Date(now.getTime() - 86400000).toISOString();
        const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
        
        const mockItems = [
          { 
            recordName: 'task_stalled_1', 
            taskName: 'Review project requirements', 
            endDate: yesterday,
            contextRecordName: 'context_work',
            realmId: 2,
            stalledReason: 'Past due date - needs rescheduling'
          },
          { 
            recordName: 'project_stalled_1', 
            projectName: 'Client presentation prep', 
            endDate: weekAgo,
            contextRecordName: 'context_work',
            realmId: 2,
            stalledReason: 'Week overdue - may need scope revision'
          }
        ];
        
        let response = `Stalled items in Decide realm (past due dates):\n`;
        response += mockItems.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const daysOverdue = Math.ceil((now.getTime() - new Date(item.endDate).getTime()) / (24 * 60 * 60 * 1000));
          return `- ${name} (${item.recordName}) - ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} overdue`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  private async getUndecidedItemsInDecide() {
    return this.withCloudKitOrMock(
      'getUndecidedItemsInDecide',
      async () => {
        // CloudKit production implementation
        const [undecidedTasks, allProjects] = await Promise.all([
          this.cloudKitService.getTasksInDecideUndecided(),
          this.cloudKitService.getProjectsByRealm(2)
        ]);

        // Filter projects that lack context or due date
        const undecidedProjects = allProjects.filter((project: any) => {
          const hasContext = project.fields?.context?.value?.recordName;
          const hasEndDate = project.fields?.endDate?.value;
          return !hasContext || !hasEndDate;
        });

        const allUndecidedItems = [...undecidedTasks, ...undecidedProjects];
        
        let response = `Undecided items in Decide realm (need context/timeline decisions):\n`;
        if (allUndecidedItems.length === 0) {
          response += 'All items in Decide realm have context and due dates set! ✅';
        } else {
          response += allUndecidedItems.map(item => {
            const isTask = item.recordType === 'Task';
            const name = isTask ? item.fields?.taskName?.value : item.fields?.projectName?.value;
            const hasContext = item.fields?.context?.value?.recordName;
            const hasEndDate = item.fields?.endDate?.value;
            const type = isTask ? 'Task' : 'Project';
            
            const missing = [];
            if (!hasContext) missing.push('context');
            if (!hasEndDate) missing.push('due date');
            
            return `- ${name} (${item.recordName}) - needs: ${missing.join(' + ')} [${type}]`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const mockItems = [
          { 
            recordName: 'task_undecided_1', 
            taskName: 'Research new marketing strategy',
            contextRecordName: null,
            endDate: null,
            realmId: 2,
            needsDecision: 'Context and timeline'
          },
          { 
            recordName: 'task_undecided_2', 
            taskName: 'Call insurance company',
            contextRecordName: 'context_home',
            endDate: null,
            realmId: 2,
            needsDecision: 'Due date scheduling'
          },
          { 
            recordName: 'project_undecided_1', 
            projectName: 'Organize home office',
            contextRecordName: null,
            endDate: null,
            realmId: 2,
            needsDecision: 'Context and timeline'
          }
        ];
        
        let response = `Undecided items in Decide realm (need context/timeline decisions):\n`;
        response += mockItems.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const missing = [];
          if (!item.contextRecordName) missing.push('context');
          if (!item.endDate) missing.push('due date');
          return `- ${name} (${item.recordName}) - needs: ${missing.join(' + ')}`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  private async getReadyItemsInDecide() {
    return this.withCloudKitOrMock(
      'getReadyItemsInDecide',
      async () => {
        // CloudKit production implementation
        const [readyTasks, allProjects] = await Promise.all([
          this.cloudKitService.getTasksInDecideReady(),
          this.cloudKitService.getProjectsByRealm(2)
        ]);

        // Filter projects that have both context and future due date
        const now = new Date();
        const readyProjects = allProjects.filter((project: any) => {
          const hasContext = project.fields?.context?.value?.recordName;
          const endDate = project.fields?.endDate?.value;
          const hasFutureEndDate = endDate && new Date(endDate) > now;
          return hasContext && hasFutureEndDate;
        });

        const allReadyItems = [...readyTasks, ...readyProjects];
        
        let response = `Ready items in Decide realm (context + future due date set):\n`;
        if (allReadyItems.length === 0) {
          response += 'No items are ready for Do realm. Check undecided and stalled items first! 📋';
        } else {
          response += allReadyItems.map(item => {
            const isTask = item.recordType === 'Task';
            const name = isTask ? item.fields?.taskName?.value : item.fields?.projectName?.value;
            const contextRecordName = item.fields?.context?.value?.recordName;
            const endDate = item.fields?.endDate?.value;
            const type = isTask ? 'Task' : 'Project';
            
            const dueDate = new Date(endDate).toLocaleDateString();
            const contextName = contextRecordName?.replace('context_', '') || 'Unknown';
            
            return `- ${name} (${item.recordName}) - Due: ${dueDate}, Context: ${contextName} [${type}]`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const tomorrow = new Date(Date.now() + 86400000).toISOString();
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString();
        
        const mockItems = [
          { 
            recordName: 'task_ready_1', 
            taskName: 'Schedule dentist appointment',
            contextRecordName: 'context_personal',
            endDate: tomorrow,
            realmId: 2,
            readyStatus: 'Fully planned - ready for Do realm'
          },
          { 
            recordName: 'task_ready_2', 
            taskName: 'Submit expense report',
            contextRecordName: 'context_work',
            endDate: nextWeek,
            realmId: 2,
            readyStatus: 'Context and deadline set'
          },
          { 
            recordName: 'project_ready_1', 
            projectName: 'Plan weekend camping trip',
            contextRecordName: 'context_personal',
            endDate: nextWeek,
            realmId: 2,
            readyStatus: 'Timeline and context decided'
          }
        ];
        
        let response = `Ready items in Decide realm (context + future due date set):\n`;
        response += mockItems.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const dueDate = new Date(item.endDate).toLocaleDateString();
          const contextName = item.contextRecordName?.replace('context_', '') || 'Unknown';
          return `- ${name} (${item.recordName}) - Due: ${dueDate}, Context: ${contextName}`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  // DO REALM SUBDIVISIONS - Enhanced time-based filtering matching iOS app
  private async getTasksTodayInDo() {
    return this.withCloudKitOrMock(
      'getTasksTodayInDo',
      async () => {
        // CloudKit production implementation
        const todaysTasks = await this.cloudKitService.getTasksInDoToday();
        
        let response = `Today's items in Do realm (due: ${new Date().toLocaleDateString()}):\n`;
        if (todaysTasks.length === 0) {
          response += 'No tasks scheduled for today in Do realm! 🎉 Time to move some ready items from Decide realm?';
        } else {
          response += todaysTasks.map((task: any) => {
            const name = task.fields?.taskName?.value || 'Unnamed Task';
            const contextRecordName = task.fields?.context?.value?.recordName;
            const contextName = contextRecordName?.replace('context_', '') || 'No context';
            const priority = task.fields?.taskPriority?.value || 3;
            const priorityIcon = priority === 1 ? '🔴 High' : priority === 2 ? '🟡 Medium' : '🟢 Low';
            
            return `- ${name} (${task.recordName}) - ${contextName} - ${priorityIcon}`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        
        const mockTasks = [
          { 
            recordName: 'task_today_1', 
            taskName: 'Morning standup meeting', 
            realmId: 3, 
            endDate: todayStr,
            contextRecordName: 'context_work',
            priority: 1,
            timeEstimate: '30 minutes'
          },
          { 
            recordName: 'task_today_2', 
            taskName: 'Pick up groceries', 
            realmId: 3, 
            endDate: todayStr,
            contextRecordName: 'context_errands',
            priority: 2,
            timeEstimate: '45 minutes'
          },
          { 
            recordName: 'project_today_1', 
            projectName: 'Review quarterly goals', 
            realmId: 3, 
            endDate: todayStr,
            contextRecordName: 'context_work',
            priority: 1,
            timeEstimate: '2 hours'
          }
        ];
        
        let response = `Today's items in Do realm (due: ${today.toLocaleDateString()}):\n`;
        response += mockTasks.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const contextName = item.contextRecordName?.replace('context_', '') || 'No context';
          const priority = item.priority === 1 ? '🔴 High' : item.priority === 2 ? '🟡 Medium' : '🟢 Low';
          return `- ${name} (${item.recordName}) - ${contextName} - ${priority} - ~${item.timeEstimate}`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  private async getTasksTomorrowInDo() {
    return this.withCloudKitOrMock(
      'getTasksTomorrowInDo',
      async () => {
        // CloudKit production implementation
        const tomorrowsTasks = await this.cloudKitService.getTasksInDoTomorrow();
        
        let response = `Tomorrow's items in Do realm (due: ${new Date(Date.now() + 86400000).toLocaleDateString()}):\n`;
        if (tomorrowsTasks.length === 0) {
          response += 'No tasks scheduled for tomorrow in Do realm! 📅';
        } else {
          response += tomorrowsTasks.map((task: any) => {
            const name = task.fields?.taskName?.value || 'Unnamed Task';
            const contextRecordName = task.fields?.context?.value?.recordName;
            const contextName = contextRecordName?.replace('context_', '') || 'No context';
            const priority = task.fields?.taskPriority?.value || 3;
            const priorityIcon = priority === 1 ? '🔴 High' : priority === 2 ? '🟡 Medium' : '🟢 Low';
            
            return `- ${name} (${task.recordName}) - ${contextName} - ${priorityIcon}`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const tomorrow = new Date(Date.now() + 86400000);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];
        
        const mockTasks = [
          { 
            recordName: 'task_tomorrow_1', 
            taskName: 'Dentist appointment', 
            realmId: 3, 
            endDate: tomorrowStr,
            contextRecordName: 'context_personal',
            priority: 1,
            timeEstimate: '1 hour'
          },
          { 
            recordName: 'task_tomorrow_2', 
            taskName: 'Prepare presentation slides', 
            realmId: 3, 
            endDate: tomorrowStr,
            contextRecordName: 'context_work',
            priority: 2,
            timeEstimate: '3 hours'
          }
        ];
        
        let response = `Tomorrow's items in Do realm (due: ${tomorrow.toLocaleDateString()}):\n`;
        response += mockTasks.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const contextName = item.contextRecordName?.replace('context_', '') || 'No context';
          const priority = item.priority === 1 ? '🔴 High' : item.priority === 2 ? '🟡 Medium' : '🟢 Low';
          return `- ${name} (${item.recordName}) - ${contextName} - ${priority} - ~${item.timeEstimate}`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  private async getTasksSoonInDo() {
    return this.withCloudKitOrMock(
      'getTasksSoonInDo',
      async () => {
        // CloudKit production implementation
        const soonTasks = await this.cloudKitService.getTasksInDoSoon();
        
        let response = `Soon items in Do realm (due within next 2-7 days):\n`;
        if (soonTasks.length === 0) {
          response += 'No tasks due soon in Do realm! 📋 Good planning ahead!';
        } else {
          response += soonTasks.map((task: any) => {
            const name = task.fields?.taskName?.value || 'Unnamed Task';
            const contextRecordName = task.fields?.context?.value?.recordName;
            const contextName = contextRecordName?.replace('context_', '') || 'No context';
            const priority = task.fields?.taskPriority?.value || 3;
            const priorityIcon = priority === 1 ? '🔴 High' : priority === 2 ? '🟡 Medium' : '🟢 Low';
            const endDate = task.fields?.endDate?.value;
            const dueDate = new Date(endDate).toLocaleDateString();
            const daysUntil = Math.ceil((new Date(endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
            
            return `- ${name} (${task.recordName}) - Due: ${dueDate} (${daysUntil} days) - ${contextName} - ${priorityIcon}`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const now = new Date();
        const threeDays = new Date(now.getTime() + 3 * 86400000);
        const sevenDays = new Date(now.getTime() + 7 * 86400000);
        
        const mockTasks = [
          { 
            recordName: 'task_soon_1', 
            taskName: 'Submit tax documents', 
            realmId: 3, 
            endDate: threeDays.toISOString().split('T')[0],
            contextRecordName: 'context_personal',
            priority: 1,
            timeEstimate: '2 hours',
            daysUntilDue: 3
          },
          { 
            recordName: 'project_soon_1', 
            projectName: 'Plan team offsite', 
            realmId: 3, 
            endDate: sevenDays.toISOString().split('T')[0],
            contextRecordName: 'context_work',
            priority: 2,
            timeEstimate: '5 hours',
            daysUntilDue: 7
          }
        ];
        
        let response = `Soon items in Do realm (due within next 2-7 days):\n`;
        response += mockTasks.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const contextName = item.contextRecordName?.replace('context_', '') || 'No context';
          const priority = item.priority === 1 ? '🔴 High' : item.priority === 2 ? '🟡 Medium' : '🟢 Low';
          const dueDate = new Date(item.endDate).toLocaleDateString();
          return `- ${name} (${item.recordName}) - Due: ${dueDate} (${item.daysUntilDue} days) - ${contextName} - ${priority}`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  private async getTasksOverdueInDo() {
    return this.withCloudKitOrMock(
      'getTasksOverdueInDo',
      async () => {
        // CloudKit production implementation
        const overdueTasks = await this.cloudKitService.getTasksInDoOverdue();
        
        let response = `Overdue items in Do realm (past due dates - need immediate attention):\n`;
        if (overdueTasks.length === 0) {
          response += 'No overdue tasks in Do realm! 🎉 Great job staying on track!';
        } else {
          response += overdueTasks.map((task: any) => {
            const name = task.fields?.taskName?.value || 'Unnamed Task';
            const contextRecordName = task.fields?.context?.value?.recordName;
            const contextName = contextRecordName?.replace('context_', '') || 'No context';
            const priority = task.fields?.taskPriority?.value || 3;
            const priorityIcon = priority === 1 ? '🔴 High' : priority === 2 ? '🟡 Medium' : '🟢 Low';
            const endDate = task.fields?.endDate?.value;
            const overdueDays = Math.ceil((Date.now() - new Date(endDate).getTime()) / (24 * 60 * 60 * 1000));
            const urgency = overdueDays > 3 ? '⚠️ URGENT' : '❗ Overdue';
            
            return `- ${urgency} ${name} (${task.recordName}) - ${overdueDays} day${overdueDays > 1 ? 's' : ''} overdue - ${contextName} - ${priorityIcon}`;
          }).join('\n');
        }
        
        return { content: [{ type: 'text', text: response }] };
      },
      async () => {
        // Mock implementation
        const now = new Date();
        const yesterday = new Date(now.getTime() - 86400000);
        const weekAgo = new Date(now.getTime() - 7 * 86400000);
        
        const mockTasks = [
          { 
            recordName: 'task_overdue_1', 
            taskName: 'Submit expense report', 
            realmId: 3, 
            endDate: yesterday.toISOString().split('T')[0],
            contextRecordName: 'context_work',
            priority: 1,
            daysOverdue: 1
          },
          { 
            recordName: 'project_overdue_1', 
            projectName: 'Clean garage', 
            realmId: 3, 
            endDate: weekAgo.toISOString().split('T')[0],
            contextRecordName: 'context_home',
            priority: 3,
            daysOverdue: 7
          }
        ];
        
        let response = `Overdue items in Do realm (past due dates - need immediate attention):\n`;
        response += mockTasks.map(item => {
          const type = item.recordName.startsWith('task_') ? 'Task' : 'Project';
          const name = item.taskName || (item as any).projectName;
          const contextName = item.contextRecordName?.replace('context_', '') || 'No context';
          const priority = item.priority === 1 ? '🔴 High' : item.priority === 2 ? '🟡 Medium' : '🟢 Low';
          const overdueDays = item.daysOverdue;
          const urgency = overdueDays > 3 ? '⚠️ URGENT' : '❗ Overdue';
          return `- ${urgency} ${name} (${item.recordName}) - ${overdueDays} day${overdueDays > 1 ? 's' : ''} overdue - ${contextName} - ${priority}`;
        }).join('\n');
        
        return { content: [{ type: 'text', text: response }] };
      }
    );
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('addTaskManager MCP server (XCDATAMODEL compliant) running on stdio');
  }
}

// Ensure you have uuid installed: npm install uuid
// and types: npm install @types/uuid --save-dev

const server = new AddTaskManagerMCPServer();
server.run().catch(error => {
    console.error("Failed to run server:", error);
    process.exit(1);
});