#!/usr/bin/env node

/**
 * ZenTasktic MCP Server
 *
 * An MCP server that integrates with ZenTasktic iOS/macOS app via CloudKit.js
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

interface ZenTaskticTask {
  recordName?: string; // CloudKit record name (UUID string, typically)
  recordType: 'Task';
  fields: {
    taskName: { value: string }; // Max 1000 chars, combines original title & body
    realmId: { value: number }; // 1 (Assess), 2 (Decide), 3 (Do)
    uniqueId: { value: string }; // UUID string, primary key in CoreData model
    context?: { value: CKReference }; // Reference to a Contexts record
    project?: { value: CKReference }; // Reference to a Projects record
    collection?: { value: CKReference }; // Reference to a Collections record
    ideas?: { value: CKReference }; // Reference to an Ideas record (if task derived from idea)
    startDate?: { value: number }; // Timestamp (milliseconds since epoch)
    endDate?: { value: number }; // Timestamp (due date, or completion date)
    lastModified: { value: number }; // Timestamp
    localNotification?: { value: string }; // Alert date/trigger (e.g., ISO string)
    taskPriority?: { value: number }; // 1-5, default 3
    orderInParent?: { value: number }; // For subtasks/ordering
    taskParentId?: { value: string }; // UUID string of parent Task/Project/Idea
    taskParentType?: { value: string }; // 'Task', 'Project', 'Idea'
    // removed isCompleted, completion handled by setting endDate & potentially realm
  };
}

interface ZenTaskticProject {
  recordName?: string;
  recordType: 'Project';
  fields: {
    projectName: { value: string }; // Max 1500 chars
    realmId: { value: number };
    uniqueId: { value: string };
    context?: { value: CKReference };
    collection?: { value: CKReference };
    startDate?: { value: number };
    endDate?: { value: number };
    lastModified: { value: number };
    tasks?: { value: CKReference[] }; // List of references to Task records
    // removed description (use projectName), removed isCompleted
  };
}

interface ZenTaskticIdea {
  recordName?: string;
  recordType: 'Idea';
  fields: {
    ideaName: { value: string }; // Max 1500 chars, combines original title & body
    realmId: { value: number }; // Default REALM_ASSESS_ID
    uniqueId: { value: string };
    lastModified: { value: number };
    collection?: { value: CKReference };
    tasks?: { value: CKReference[] }; // Tasks derived from this idea
    // removed createdAt, use lastModified or CloudKit system creationDate
  };
}

interface ZenTaskticContext {
  recordName?: string;
  recordType: 'Contexts';
  fields: {
    contextName: { value: string };
    uniqueId: { value: string };
    lastModified: { value: number };
  };
}


class ZenTaskticMCPServer {
  private server: Server;
  private cloudKitConfig: CloudKitConfig;
  private userToken: UserToken | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'zentasktic-mcp-server',
        version: '1.1.0', // Updated version
        description: 'MCP server for ZenTasktic with ADD framework support, aligned with XCDATAMODEL',
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
            description: 'Authenticate user with Apple ID to access their ZenTasktic data',
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

          // Decide Realm Tools (realmId 2)
          {
            name: 'decide_assign_context_to_item',
            description: 'Assign context to a task or project in Decide realm.',
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
            name: 'decide_set_due_date_for_item',
            description: 'Set due date (endDate) for a task or project in Decide realm.',
            inputSchema: {
              type: 'object',
              properties: {
                itemRecordName: { type: 'string', description: 'Record name of the task or project' },
                itemType: { type: 'string', enum: ['Task', 'Project'], description: 'Type of item (Task or Project)' },
                endDate: { type: 'string', format: 'date-time', description: 'Due date in ISO format' }
              },
              required: ['itemRecordName', 'itemType', 'endDate']
            }
          },
          {
            name: 'decide_set_alert_for_task',
            description: 'Set alert (localNotification) for a task in Decide realm.',
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
            name: 'decide_move_item_to_do_realm',
            description: 'Move task/project from Decide (realmId 2) to Do realm (realmId 3).',
            inputSchema: {
              type: 'object',
              properties: {
                itemRecordName: { type: 'string', description: 'Task or project record name' },
                itemType: { type: 'string', enum: ['Task', 'Project'], description: 'Type of item (Task or Project)' }
              },
              required: ['itemRecordName', 'itemType']
            }
          },

          // Do Realm Tools (realmId 3)
          {
            name: 'do_complete_task',
            description: 'Mark task as completed in Do realm (sets endDate to now).',
            inputSchema: {
              type: 'object',
              properties: {
                taskRecordName: { type: 'string', description: 'Task record name' }
              },
              required: ['taskRecordName']
            }
          },
          {
            name: 'do_complete_project',
            description: 'Mark project as completed in Do realm (sets endDate to now).',
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
            name: 'get_items_by_realm', // Combined tasks and projects
            description: 'Get all tasks and projects in a specified realm.',
            inputSchema: {
              type: 'object',
              properties: {
                realm: { type: 'string', enum: ['assess', 'decide', 'do'], description: 'Realm to query (maps to realmId 1, 2, or 3)' }
              },
              required: ['realm']
            }
          },
          {
            name: 'get_ideas_all', // Ideas are typically assess realm
            description: 'Get all ideas (ideas primarily exist in assess realm).',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_tasks_by_context',
            description: 'Get tasks filtered by a specific context.',
            inputSchema: {
              type: 'object',
              properties: {
                contextRecordName: { type: 'string', description: 'Record name of the context to filter by' }
              },
              required: ['contextRecordName']
            }
          },
          {
            name: 'get_overdue_tasks',
            description: 'Get all tasks where endDate is in the past and not yet fully completed (e.g. still in Do realm).',
            inputSchema: { type: 'object', properties: {} }
          }
        ] as Tool[]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
          case 'assess_create_idea':
            this.validateArgs(args, ['ideaName']);
            return await this.createIdea(args.ideaName, args.collectionRecordName);

          // Decide Realm Operations
          case 'decide_assign_context_to_item':
            this.validateArgs(args, ['itemRecordName', 'itemType', 'contextRecordName']);
            if (!['Task', 'Project'].includes(args.itemType)) {
                throw new McpError(ErrorCode.InvalidParams, "itemType must be 'Task' or 'Project'.");
            }
            return await this.assignContextToItem(args.itemRecordName, args.itemType as 'Task' | 'Project', args.contextRecordName);
          case 'decide_set_due_date_for_item':
            this.validateArgs(args, ['itemRecordName', 'itemType', 'endDate']);
             if (!['Task', 'Project'].includes(args.itemType)) {
                throw new McpError(ErrorCode.InvalidParams, "itemType must be 'Task' or 'Project'.");
            }
            return await this.setDueDateForItem(args.itemRecordName, args.itemType as 'Task' | 'Project', args.endDate);
          case 'decide_set_alert_for_task':
            this.validateArgs(args, ['taskRecordName', 'alertDateTime']);
            return await this.setAlertForTask(args.taskRecordName, args.alertDateTime);
          case 'decide_move_item_to_do_realm':
            this.validateArgs(args, ['itemRecordName', 'itemType']);
            if (!['Task', 'Project'].includes(args.itemType)) {
                throw new McpError(ErrorCode.InvalidParams, "itemType must be 'Task' or 'Project'.");
            }
            return await this.moveItemToRealm(args.itemRecordName, args.itemType as 'Task' | 'Project', 'do');

          // Do Realm Operations
          case 'do_complete_task':
            this.validateArgs(args, ['taskRecordName']);
            return await this.completeTask(args.taskRecordName);
          case 'do_complete_project':
            this.validateArgs(args, ['projectRecordName']);
            return await this.completeProject(args.projectRecordName);

          // Query Operations
          case 'get_items_by_realm':
            this.validateArgs(args, ['realm']);
            return await this.getItemsByRealm(args.realm as RealmString);
          case 'get_ideas_all':
            return await this.getIdeas();
          case 'get_tasks_by_context':
            this.validateArgs(args, ['contextRecordName']);
            return await this.getTasksByContext(args.contextRecordName);
          case 'get_overdue_tasks':
            return await this.getOverdueTasks();

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

  private async authenticateUser(webAuthToken: string) {
    // Mock authentication: In reality, validate token with Apple/CloudKit
    this.userToken = {
      cloudKitWebAuthToken: webAuthToken,
      userIdentity: { userRecordName: `user_${uuidv4()}`, lookupInfo: {} }
    };
    return { content: [{ type: 'text', text: 'Successfully authenticated. You can now access ZenTasktic data.' }] };
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
      recordType: 'Project',
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
      recordType: 'Idea',
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
    // Mock fetch & check realm (should be REALM_DECIDE_ID)
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

  private async moveItemToRealm(itemRecordName: string, itemType: 'Task' | 'Project', targetRealmStr: RealmString) {
    const targetRealmId = realmStringToId(targetRealmStr);
    // Mock fetch item
    // Mock update realmId: console.log('Mock CloudKit: Moving', itemType, itemRecordName, 'to realmId', targetRealmId);
    return { content: [{ type: 'text', text: `${itemType} ${itemRecordName} moved to ${targetRealmStr} realm (ID: ${targetRealmId}).` }] };
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
    // Mock query (Ideas are typically realmId 1)
    // console.log('Mock CloudKit: Fetching all Ideas');
    const mockIdeas = [{ recordName: 'idea_789', ideaName: 'Brilliant Idea Z' }];
    return { content: [{ type: 'text', text: `Found ${mockIdeas.length} ideas:\n${mockIdeas.map(i => `- ${i.ideaName} (${i.recordName})`).join('\n')}` }] };
  }

  private async getTasksByContext(contextRecordName: string) {
    // Mock query
    // console.log('Mock CloudKit: Fetching tasks for context', contextRecordName);
    const mockTasks = [{ recordName: 'task_abc', taskName: 'Task with specific context' }];
    return { content: [{ type: 'text', text: `Found ${mockTasks.length} tasks for context ${contextRecordName}:\n${mockTasks.map(t => `- ${t.taskName} (${t.recordName})`).join('\n')}` }] };
  }

  private async getOverdueTasks() {
    // Mock query: tasks where endDate < now AND (e.g. realmId IS REALM_DO_ID or not yet marked explicitly 'done' if there was a separate status)
    // console.log('Mock CloudKit: Fetching overdue tasks');
    const mockOverdue = [{ recordName: 'task_def', taskName: 'Overdue Task Alpha', endDate: new Date(Date.now() - 86400000).toISOString() }];
    return { content: [{ type: 'text', text: `Found ${mockOverdue.length} overdue tasks:\n${mockOverdue.map(t => `- ${t.taskName} (${t.recordName}), due: ${t.endDate}`).join('\n')}` }] };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('ZenTasktic MCP server (XCDATAMODEL compliant) running on stdio');
  }
}

// Ensure you have uuid installed: npm install uuid
// and types: npm install @types/uuid --save-dev

const server = new ZenTaskticMCPServer();
server.run().catch(error => {
    console.error("Failed to run server:", error);
    process.exit(1);
});