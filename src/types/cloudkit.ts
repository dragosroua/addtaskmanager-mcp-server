// CloudKit integration types for production deployment
export interface CloudKitConfig {
  containerID: string;
  apiToken: string;
  environment: 'development' | 'production';
  serverKey?: string;
  authMethod: 'user' | 'server-to-server';
}

export interface CloudKitRecord<T> {
  recordType: string;
  recordName?: string;
  fields: T;
  recordChangeTag?: string;
  created?: {
    timestamp: number;
    userRecordName?: string;
    deviceID?: string;
  };
  modified?: {
    timestamp: number;
    userRecordName?: string;
    deviceID?: string;
  };
}

export interface QueryOptions {
  filterBy?: FilterCondition[];
  sortBy?: SortDescriptor[];
  resultsLimit?: number;
  desiredKeys?: string[];
  continuationMarker?: string;
  zoneID?: ZoneID;
}

export interface FilterCondition {
  fieldName: string;
  comparator: 'EQUALS' | 'NOT_EQUALS' | 'LESS_THAN' | 'LESS_THAN_OR_EQUALS' | 
             'GREATER_THAN' | 'GREATER_THAN_OR_EQUALS' | 'NEAR' | 'CONTAINS_ALL_TOKENS' | 
             'IN' | 'NOT_IN' | 'CONTAINS_ANY_TOKENS' | 'LIST_CONTAINS' | 'NOT_LIST_CONTAINS' |
             'NOT_LIST_CONTAINS_ANY' | 'BEGINS_WITH' | 'NOT_BEGINS_WITH';
  fieldValue: any;
  distance?: number; // For NEAR comparator
}

export interface SortDescriptor {
  fieldName: string;
  ascending: boolean;
}

export interface ZoneID {
  zoneName: string;
  ownerRecordName?: string;
}

export interface UserSession {
  sessionId: string;
  webAuthToken: string;
  userId: string;
  userRecordName: string;
  createdAt: Date;
  expiresAt: Date;
  containerID: string;
}

export interface AuthResult {
  success: boolean;
  sessionId?: string;
  userId?: string;
  userRecordName?: string;
  expiresAt?: Date;
  authUrl?: string;
  message?: string;
  redirectToSignIn?: boolean;
}

// CloudKit Web Services Response Types
export interface CloudKitResponse<T> {
  records?: T[];
  hasErrors: boolean;
  errors?: CloudKitError[];
  continuationMarker?: string;
}

export interface CloudKitError {
  reason: string;
  serverErrorCode: string;
  uuid?: string;
  recordName?: string;
  subscriptionID?: string;
  redirectURL?: string;
}

// Production Security Types
export interface SecurityConfig {
  encryptionKey: string;
  allowedOrigins: string[];
  rateLimiting: {
    windowMs: number;
    maxRequests: number;
    skipSuccessfulRequests?: boolean;
  };
  auditLogging: boolean;
  sessionTimeout: number; // in milliseconds
}

export interface AuditLogEntry {
  timestamp: Date;
  userId: string;
  sessionId: string;
  operation: string;
  resourceType: string;
  resourceId?: string;
  success: boolean;
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}

// ADD Framework Specific Types
export interface RealmTransition {
  fromRealm: number;
  toRealm: number;
  itemType: 'Task' | 'Project' | 'Idea';
  itemRecordName: string;
  userId: string;
  timestamp: Date;
  validationPassed: boolean;
  validationMessage?: string;
}

export interface ADD_Item {
  recordName: string;
  recordType: string;
  realmId: number;
  lastModified: number;
  uniqueId: string;
  contextRecordName?: string;
  endDate?: number;
  startDate?: number;
  // Task-specific
  taskName?: string;
  taskPriority?: number;
  taskAudioRecordId?: number;
  taskPictureId?: number;
  localNotification?: string;
  orderInParent?: number;
  // Project-specific  
  projectName?: string;
  // Idea-specific
  ideaName?: string;
}

// Production Monitoring Types
export interface HealthCheck {
  timestamp: Date;
  cloudKitConnected: boolean;
  authServiceHealthy: boolean;
  databaseReachable: boolean;
  responseTime: number;
  activeUsers: number;
  errorRate: number;
  memoryUsage: number;
  cpuUsage: number;
}

export interface UsageMetrics {
  userId: string;
  sessionId: string;
  operationsPerHour: number;
  dataTransferMB: number;
  storageUsedMB: number;
  lastActivity: Date;
  operationCounts: {
    create: number;
    read: number;
    update: number;
    delete: number;
    query: number;
  };
}