import { CloudKitConfig, SecurityConfig } from '../types/cloudkit';

/**
 * Production configuration for CloudKit integration
 */

// Environment variables validation
const requiredEnvVars = [
  'CLOUDKIT_CONTAINER_ID',
  'CLOUDKIT_API_TOKEN'
];

function validateEnvironment(): void {
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Validate environment on module load
validateEnvironment();

export const productionConfig: CloudKitConfig = {
  containerID: process.env.CLOUDKIT_CONTAINER_ID!,
  apiToken: process.env.CLOUDKIT_API_TOKEN!,
  serverKey: process.env.CLOUDKIT_SERVER_KEY, // Optional for server-to-server auth
  environment: (process.env.CLOUDKIT_ENVIRONMENT as 'development' | 'production') || 'production',
  authMethod: (process.env.CLOUDKIT_AUTH_METHOD as 'user' | 'server-to-server') || 'user'
};

export const securityConfig: SecurityConfig = {
  encryptionKey: process.env.ENCRYPTION_KEY || generateDefaultEncryptionKey(),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
  rateLimiting: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
    skipSuccessfulRequests: process.env.RATE_LIMIT_SKIP_SUCCESSFUL === 'true'
  },
  auditLogging: process.env.AUDIT_LOGGING !== 'false', // Default to true
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_MS || '86400000') // 24 hours
};

// Development configuration (less restrictive)
export const developmentConfig: CloudKitConfig = {
  containerID: process.env.CLOUDKIT_CONTAINER_ID || 'com.example.addtaskmanager.dev',
  apiToken: process.env.CLOUDKIT_API_TOKEN || 'development-token',
  environment: 'development',
  authMethod: 'user'
};

export const developmentSecurityConfig: SecurityConfig = {
  encryptionKey: 'development-key-not-for-production',
  allowedOrigins: ['*'],
  rateLimiting: {
    windowMs: 60000, // 1 minute
    maxRequests: 1000, // Much higher for development
    skipSuccessfulRequests: true
  },
  auditLogging: true,
  sessionTimeout: 3600000 // 1 hour
};

function generateDefaultEncryptionKey(): string {
  console.warn('WARNING: Using auto-generated encryption key. Set ENCRYPTION_KEY environment variable in production.');
  return require('crypto').randomBytes(32).toString('hex');
}

/**
 * Get configuration based on environment
 */
export function getCloudKitConfig(): CloudKitConfig {
  const env = process.env.NODE_ENV || 'development';
  return env === 'production' ? productionConfig : developmentConfig;
}

export function getSecurityConfig(): SecurityConfig {
  const env = process.env.NODE_ENV || 'development';
  return env === 'production' ? securityConfig : developmentSecurityConfig;
}

/**
 * Deployment strategy configurations
 */
export interface DeploymentStrategy {
  name: string;
  description: string;
  userSetupComplexity: 'low' | 'medium' | 'high';
  dataPrivacy: 'shared' | 'isolated' | 'user-owned';
  scalability: 'low' | 'medium' | 'high';
  maintenanceBurden: 'low' | 'medium' | 'high';
}

export const deploymentStrategies: Record<string, DeploymentStrategy> = {
  'user-owned': {
    name: 'User-Owned CloudKit Container',
    description: 'Each user creates their own CloudKit container and provides credentials',
    userSetupComplexity: 'high',
    dataPrivacy: 'user-owned',
    scalability: 'high',
    maintenanceBurden: 'low'
  },
  'shared-service': {
    name: 'Shared Service Provider',
    description: 'Single CloudKit container with user authentication and data isolation',
    userSetupComplexity: 'low',
    dataPrivacy: 'isolated',
    scalability: 'medium',
    maintenanceBurden: 'high'
  },
  'hybrid': {
    name: 'Hybrid Approach',
    description: 'Free tier with shared container, premium tier with user-owned containers',
    userSetupComplexity: 'medium',
    dataPrivacy: 'isolated',
    scalability: 'high',
    maintenanceBurden: 'medium'
  }
};

/**
 * User onboarding configurations
 */
export interface OnboardingConfig {
  strategy: keyof typeof deploymentStrategies;
  requiresAppleId: boolean;
  requiresCloudKitContainer: boolean;
  setupSteps: string[];
  estimatedSetupTime: string;
}

export const onboardingConfigs: Record<string, OnboardingConfig> = {
  'user-owned': {
    strategy: 'user-owned',
    requiresAppleId: true,
    requiresCloudKitContainer: true,
    setupSteps: [
      'Create Apple Developer account (if not already)',
      'Create CloudKit container in Apple Developer Portal',
      'Import provided schema template',
      'Generate API token in CloudKit Dashboard',
      'Configure MCP server with container ID and token',
      'Authenticate with iCloud when first connecting'
    ],
    estimatedSetupTime: '15-30 minutes'
  },
  'shared-service': {
    strategy: 'shared-service',
    requiresAppleId: true,
    requiresCloudKitContainer: false,
    setupSteps: [
      'Install addTaskManager MCP server',
      'Add server to AI app configuration',
      'Authenticate with Apple ID when prompted',
      'Grant CloudKit access permissions'
    ],
    estimatedSetupTime: '5 minutes'
  },
  'hybrid': {
    strategy: 'hybrid',
    requiresAppleId: true,
    requiresCloudKitContainer: false,
    setupSteps: [
      'Install addTaskManager MCP server',
      'Choose free or premium tier',
      'For premium: Create own CloudKit container',
      'Authenticate with Apple ID',
      'Configure based on selected tier'
    ],
    estimatedSetupTime: '5-20 minutes'
  }
};

/**
 * Cost estimation helpers
 */
export interface CostEstimate {
  setup: {
    developmentTime: string;
    infrastructureCost: number; // USD per month
  };
  perUser: {
    storageGB: number;
    transferGB: number;
    estimatedMonthlyCost: number; // USD
  };
  breakEvenUsers: number;
}

export function calculateCostEstimate(strategy: keyof typeof deploymentStrategies): CostEstimate {
  const baseCloudKitCosts = {
    storagePerGB: 0.50, // USD per month
    transferPerGB: 0.10  // USD per month
  };

  switch (strategy) {
    case 'user-owned':
      return {
        setup: {
          developmentTime: '4-6 weeks',
          infrastructureCost: 0 // Users pay their own CloudKit costs
        },
        perUser: {
          storageGB: 0.1, // Typical task manager usage
          transferGB: 0.05,
          estimatedMonthlyCost: 0 // User pays directly to Apple
        },
        breakEvenUsers: 0
      };

    case 'shared-service':
      return {
        setup: {
          developmentTime: '6-8 weeks',
          infrastructureCost: 50 // Base infrastructure
        },
        perUser: {
          storageGB: 0.1,
          transferGB: 0.05,
          estimatedMonthlyCost: baseCloudKitCosts.storagePerGB * 0.1 + baseCloudKitCosts.transferPerGB * 0.05
        },
        breakEvenUsers: Math.ceil(50 / (baseCloudKitCosts.storagePerGB * 0.1 + baseCloudKitCosts.transferPerGB * 0.05))
      };

    case 'hybrid':
      return {
        setup: {
          developmentTime: '8-10 weeks',
          infrastructureCost: 25 // Shared infrastructure for free tier
        },
        perUser: {
          storageGB: 0.05, // Free tier users use less
          transferGB: 0.025,
          estimatedMonthlyCost: baseCloudKitCosts.storagePerGB * 0.025 + baseCloudKitCosts.transferPerGB * 0.01
        },
        breakEvenUsers: Math.ceil(25 / (baseCloudKitCosts.storagePerGB * 0.025 + baseCloudKitCosts.transferPerGB * 0.01))
      };

    default:
      throw new Error(`Unknown deployment strategy: ${strategy}`);
  }
}