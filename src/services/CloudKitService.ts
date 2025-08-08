import { 
  CloudKitConfig, 
  CloudKitRecord, 
  QueryOptions, 
  CloudKitResponse
} from '../types/cloudkit';
import { ZenTaskticTask, ZenTaskticProject, ZenTaskticIdea } from '../index';

/**
 * CloudKit Web Services integration for production deployment
 * Supports both user authentication and server-to-server authentication
 */
export class CloudKitService {
  private ck: any;
  private config!: CloudKitConfig;
  private database: any;
  private authenticated: boolean = false;
  private userIdentity: any;

  constructor() {
    // Will be initialized with configure()
  }

  /**
   * Initialize CloudKit with production configuration
   */
  async initialize(config: CloudKitConfig): Promise<void> {
    this.config = config;
    
    try {
      // Load CloudKit JS - in production, this should be downloaded and cached
      const CloudKit = await this.loadCloudKitJS();
      
      // Configure CloudKit with production settings
      CloudKit.configure({
        locale: 'en-us',
        containers: [{
          containerIdentifier: config.containerID,
          apiTokenAuth: {
            apiToken: config.apiToken,
            persist: config.authMethod === 'user' // Only persist for user auth
          },
          serverToServerKeyAuth: config.serverKey ? {
            keyID: config.serverKey,
            privateKeyFile: process.env.CLOUDKIT_PRIVATE_KEY_PATH,
            privateKeyPassPhrase: process.env.CLOUDKIT_PRIVATE_KEY_PASSPHRASE
          } : undefined,
          environment: config.environment
        }]
      });

      this.ck = CloudKit.getDefaultContainer();
      
      // Get appropriate database based on auth method
      if (config.authMethod === 'user') {
        this.database = this.ck.getDatabaseWithDatabaseScope(CloudKit.DatabaseScope.PRIVATE);
      } else {
        // Server-to-server can only access public database
        this.database = this.ck.getDatabaseWithDatabaseScope(CloudKit.DatabaseScope.PUBLIC);
      }

      console.log(`CloudKit initialized for container: ${config.containerID} (${config.environment})`);
      
    } catch (error) {
      console.error('CloudKit initialization failed:', error);
      throw new Error(`CloudKit initialization failed: ${error}`);
    }
  }

  /**
   * Authenticate user with iCloud (for user auth method)
   */
  async authenticateUser(webAuthToken?: string): Promise<boolean> {
    if (this.config.authMethod !== 'user') {
      throw new Error('User authentication not available in server-to-server mode');
    }

    try {
      if (webAuthToken) {
        // Use provided web auth token
        this.userIdentity = await this.ck.setUpAuth(webAuthToken);
      } else {
        // Request user authentication flow
        this.userIdentity = await this.ck.setUpAuth();
      }

      if (this.userIdentity) {
        this.authenticated = true;
        console.log('User authenticated:', this.userIdentity.userRecordName);
        return true;
      } else {
        this.authenticated = false;
        return false;
      }
    } catch (error) {
      console.error('User authentication failed:', error);
      this.authenticated = false;
      return false;
    }
  }

  /**
   * Check if service is authenticated
   */
  isAuthenticated(): boolean {
    return this.authenticated || this.config.authMethod === 'server-to-server';
  }

  /**
   * Get current user identity (only available in user auth mode)
   */
  getUserIdentity(): any {
    return this.userIdentity;
  }

  // ==================== GENERIC CLOUDKIT OPERATIONS ====================

  /**
   * Query records with filtering and sorting
   */
  async queryRecords<T>(recordType: string, options?: QueryOptions): Promise<T[]> {
    this.ensureAuthenticated();

    const query: any = {
      recordType,
      resultsLimit: options?.resultsLimit || 200,
      desiredKeys: options?.desiredKeys
    };

    // Add filters
    if (options?.filterBy && options.filterBy.length > 0) {
      query.filterBy = options.filterBy.map(filter => ({
        fieldName: filter.fieldName,
        fieldValue: { value: filter.fieldValue },
        comparator: filter.comparator || 'EQUALS'
      }));
    }

    // Add sorting
    if (options?.sortBy && options.sortBy.length > 0) {
      query.sortBy = options.sortBy.map(sort => ({
        fieldName: sort.fieldName,
        ascending: sort.ascending
      }));
    }

    // Add zone ID if specified
    if (options?.zoneID) {
      query.zoneID = options.zoneID;
    }

    try {
      const response: CloudKitResponse<T> = await this.database.performQuery(query);
      
      if (response.hasErrors) {
        const error = response.errors?.[0];
        throw new Error(`CloudKit query failed: ${error?.reason} (${error?.serverErrorCode})`);
      }

      return response.records || [];
    } catch (error) {
      console.error('CloudKit query error:', error);
      throw error;
    }
  }

  /**
   * Save a single record
   */
  async saveRecord<T>(record: CloudKitRecord<T>): Promise<T> {
    this.ensureAuthenticated();

    try {
      const response: CloudKitResponse<T> = await this.database.saveRecords([record]);
      
      if (response.hasErrors) {
        const error = response.errors?.[0];
        throw new Error(`CloudKit save failed: ${error?.reason} (${error?.serverErrorCode})`);
      }

      return response.records?.[0] as T;
    } catch (error) {
      console.error('CloudKit save error:', error);
      throw error;
    }
  }

  /**
   * Save multiple records in batch
   */
  async saveRecords<T>(records: CloudKitRecord<T>[]): Promise<T[]> {
    this.ensureAuthenticated();

    try {
      const response: CloudKitResponse<T> = await this.database.saveRecords(records);
      
      if (response.hasErrors) {
        // Handle partial failures - some records may have saved successfully
        const errors = response.errors || [];
        console.warn(`CloudKit batch save had ${errors.length} errors:`, errors);
      }

      return response.records || [];
    } catch (error) {
      console.error('CloudKit batch save error:', error);
      throw error;
    }
  }

  /**
   * Delete a record by name
   */
  async deleteRecord(recordName: string): Promise<boolean> {
    this.ensureAuthenticated();

    try {
      const response = await this.database.deleteRecords([{ recordName }]);
      return !response.hasErrors;
    } catch (error) {
      console.error('CloudKit delete error:', error);
      return false;
    }
  }

  /**
   * Delete multiple records by name
   */
  async deleteRecords(recordNames: string[]): Promise<string[]> {
    this.ensureAuthenticated();

    const recordsToDelete = recordNames.map(recordName => ({ recordName }));

    try {
      const response = await this.database.deleteRecords(recordsToDelete);
      
      // Return successfully deleted record names
      const deletedRecords: string[] = [];
      if (!response.hasErrors) {
        deletedRecords.push(...recordNames);
      } else {
        // Handle partial deletions
        const errors = response.errors || [];
        const failedRecordNames = errors.map((error: any) => error.recordName);
        deletedRecords.push(...recordNames.filter(name => !failedRecordNames.includes(name)));
      }

      return deletedRecords;
    } catch (error) {
      console.error('CloudKit batch delete error:', error);
      return [];
    }
  }

  // ==================== ADD FRAMEWORK SPECIFIC QUERIES ====================

  /**
   * Get tasks by realm with sophisticated filtering
   */
  async getTasksByRealm(realmId: number): Promise<ZenTaskticTask[]> {
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [{ 
        fieldName: 'realmId', 
        fieldValue: realmId,
        comparator: 'EQUALS' 
      }],
      sortBy: [{ fieldName: 'lastModified', ascending: false }]
    });
  }

  /**
   * Get undecided items in Decide realm (no context OR no due date)
   */
  async getTasksInDecideUndecided(): Promise<ZenTaskticTask[]> {
    // CloudKit doesn't support complex OR conditions directly
    // We'll need to make two queries and combine results
    
    const [noContext, noDueDate] = await Promise.all([
      // Tasks with no context
      this.queryRecords<ZenTaskticTask>('Task', {
        filterBy: [
          { fieldName: 'realmId', fieldValue: 2, comparator: 'EQUALS' },
          { fieldName: 'contextRecordName', fieldValue: null, comparator: 'EQUALS' }
        ]
      }),
      // Tasks with no due date  
      this.queryRecords<ZenTaskticTask>('Task', {
        filterBy: [
          { fieldName: 'realmId', fieldValue: 2, comparator: 'EQUALS' },
          { fieldName: 'endDate', fieldValue: null, comparator: 'EQUALS' }
        ]
      })
    ]);

    // Combine and deduplicate by recordName
    const combined = [...noContext, ...noDueDate];
    const uniqueRecords = new Map();
    combined.forEach(task => {
      uniqueRecords.set((task as any).recordName, task);
    });

    return Array.from(uniqueRecords.values());
  }

  /**
   * Get stalled items in Decide realm (past due date)
   */
  async getTasksInDecideStalled(): Promise<ZenTaskticTask[]> {
    const now = new Date().getTime();
    
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [
        { fieldName: 'realmId', fieldValue: 2, comparator: 'EQUALS' },
        { fieldName: 'endDate', fieldValue: now, comparator: 'LESS_THAN' }
      ],
      sortBy: [{ fieldName: 'endDate', ascending: true }] // Most overdue first
    });
  }

  /**
   * Get ready items in Decide realm (has context AND future due date)
   */
  async getTasksInDecideReady(): Promise<ZenTaskticTask[]> {
    const now = new Date().getTime();
    
    // Get tasks with future due dates first
    const tasksWithFutureDates = await this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [
        { fieldName: 'realmId', fieldValue: 2, comparator: 'EQUALS' },
        { fieldName: 'endDate', fieldValue: now, comparator: 'GREATER_THAN' }
      ]
    });

    // Filter client-side for those that also have a context
    return tasksWithFutureDates.filter((task: any) => 
      task.fields?.contextRecordName?.value != null
    );
  }

  /**
   * Get today's tasks in Do realm
   */
  async getTasksInDoToday(): Promise<ZenTaskticTask[]> {
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0)).getTime();
    const endOfDay = new Date(today.setHours(23, 59, 59, 999)).getTime();
    
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [
        { fieldName: 'realmId', fieldValue: 3, comparator: 'EQUALS' },
        { fieldName: 'endDate', fieldValue: startOfDay, comparator: 'GREATER_THAN_OR_EQUALS' },
        { fieldName: 'endDate', fieldValue: endOfDay, comparator: 'LESS_THAN_OR_EQUALS' }
      ],
      sortBy: [{ fieldName: 'taskPriority', ascending: true }] // High priority first
    });
  }

  /**
   * Get tomorrow's tasks in Do realm
   */
  async getTasksInDoTomorrow(): Promise<ZenTaskticTask[]> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startOfDay = new Date(tomorrow.setHours(0, 0, 0, 0)).getTime();
    const endOfDay = new Date(tomorrow.setHours(23, 59, 59, 999)).getTime();
    
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [
        { fieldName: 'realmId', fieldValue: 3, comparator: 'EQUALS' },
        { fieldName: 'endDate', fieldValue: startOfDay, comparator: 'GREATER_THAN_OR_EQUALS' },
        { fieldName: 'endDate', fieldValue: endOfDay, comparator: 'LESS_THAN_OR_EQUALS' }
      ]
    });
  }

  /**
   * Get tasks due soon in Do realm (2-7 days)
   */
  async getTasksInDoSoon(): Promise<ZenTaskticTask[]> {
    const twoDaysFromNow = new Date();
    twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);
    
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [
        { fieldName: 'realmId', fieldValue: 3, comparator: 'EQUALS' },
        { fieldName: 'endDate', fieldValue: twoDaysFromNow.getTime(), comparator: 'GREATER_THAN_OR_EQUALS' },
        { fieldName: 'endDate', fieldValue: sevenDaysFromNow.getTime(), comparator: 'LESS_THAN_OR_EQUALS' }
      ],
      sortBy: [{ fieldName: 'endDate', ascending: true }]
    });
  }

  /**
   * Get overdue tasks in Do realm
   */
  async getTasksInDoOverdue(): Promise<ZenTaskticTask[]> {
    const now = new Date().getTime();
    
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [
        { fieldName: 'realmId', fieldValue: 3, comparator: 'EQUALS' },
        { fieldName: 'endDate', fieldValue: now, comparator: 'LESS_THAN' }
      ],
      sortBy: [{ fieldName: 'endDate', ascending: true }] // Most overdue first
    });
  }

  /**
   * Get projects by realm
   */
  async getProjectsByRealm(realmId: number): Promise<ZenTaskticProject[]> {
    return this.queryRecords<ZenTaskticProject>('Projects', {
      filterBy: [{ 
        fieldName: 'realmId', 
        fieldValue: realmId,
        comparator: 'EQUALS' 
      }],
      sortBy: [{ fieldName: 'lastModified', ascending: false }]
    });
  }

  /**
   * Get all ideas (typically in Assess realm)
   */
  async getIdeas(): Promise<ZenTaskticIdea[]> {
    return this.queryRecords<ZenTaskticIdea>('Ideas', {
      sortBy: [{ fieldName: 'lastModified', ascending: false }]
    });
  }

  /**
   * Get all collections
   */
  async getCollections(): Promise<any[]> {
    return this.queryRecords('Collections', {
      sortBy: [{ fieldName: 'collectionName', ascending: true }]
    });
  }

  /**
   * Get all contexts
   */
  async getContexts(): Promise<any[]> {
    return this.queryRecords('Contexts', {
      sortBy: [{ fieldName: 'contextName', ascending: true }]
    });
  }

  /**
   * Get tasks by context
   */
  async getTasksByContext(contextRecordName: string): Promise<ZenTaskticTask[]> {
    return this.queryRecords<ZenTaskticTask>('Task', {
      filterBy: [{ 
        fieldName: 'contextRecordName', 
        fieldValue: contextRecordName,
        comparator: 'EQUALS' 
      }],
      sortBy: [{ fieldName: 'endDate', ascending: true }]
    });
  }

  // ==================== PRIVATE HELPER METHODS ====================

  private async loadCloudKitJS(): Promise<any> {
    try {
      // In production, download and cache CloudKit JS locally
      const fs = require('fs');
      const path = require('path');
      const https = require('https');
      
      const cloudKitPath = path.join(__dirname, '../lib/cloudkit.js');
      
      // Check if file exists and is recent (less than 24 hours old)
      if (fs.existsSync(cloudKitPath)) {
        const stats = fs.statSync(cloudKitPath);
        const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
        
        if (ageHours < 24) {
          return require(cloudKitPath);
        }
      }

      // Download fresh copy
      console.log('Downloading latest CloudKit JS...');
      await this.downloadCloudKitJS(cloudKitPath);
      
      return require(cloudKitPath);
    } catch (error) {
      console.error('Failed to load CloudKit JS:', error);
      throw error;
    }
  }

  private downloadCloudKitJS(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      const https = require('https');
      const path = require('path');
      
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const file = fs.createWriteStream(filePath);
      
      https.get('https://cdn.apple-cloudkit.com/ck/2/cloudkit.js', (response: any) => {
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          console.log('CloudKit JS downloaded successfully');
          resolve();
        });
      }).on('error', (error: Error) => {
        fs.unlink(filePath, () => {}); // Delete partial file
        reject(error);
      });
    });
  }

  private ensureAuthenticated(): void {
    if (!this.isAuthenticated()) {
      throw new Error('CloudKit service not authenticated. Call authenticateUser() first.');
    }
  }
}