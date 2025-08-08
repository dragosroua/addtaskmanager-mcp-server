import { AuthResult, UserSession, SecurityConfig } from '../types/cloudkit';
import { CloudKitService } from './CloudKitService';

/**
 * User authentication service for production CloudKit integration
 * Handles iCloud authentication, session management, and security
 */
export class UserAuthService {
  private sessions: Map<string, UserSession> = new Map();
  private cloudKitService?: CloudKitService;
  private securityConfig?: SecurityConfig;
  private rateLimitMap: Map<string, number[]> = new Map();

  constructor(cloudKitService?: CloudKitService, securityConfig?: SecurityConfig) {
    this.cloudKitService = cloudKitService;
    this.securityConfig = securityConfig;
    
    // Start session cleanup timer
    this.startSessionCleanup();
  }

  /**
   * Authenticate user with iCloud and create session
   */
  async authenticateUser(webAuthToken?: string): Promise<AuthResult> {
    try {
      // Check rate limiting
      if (this.securityConfig?.rateLimiting && !this.checkRateLimit('auth')) {
        return {
          success: false,
          message: 'Rate limit exceeded. Please try again later.'
        };
      }

      // If no token provided, initiate authentication flow
      if (!webAuthToken) {
        return {
          success: false,
          authUrl: this.generateAuthUrl(),
          message: 'User authentication required. Please visit the provided URL to sign in with your Apple ID.',
          redirectToSignIn: true
        };
      }

      // Validate the provided token with CloudKit
      const isValid = await this.validateWebAuthToken(webAuthToken);
      if (!isValid) {
        return {
          success: false,
          message: 'Invalid or expired authentication token. Please authenticate again.'
        };
      }

      // Get user identity from CloudKit
      const userIdentity = await this.getUserIdentityFromToken(webAuthToken);
      if (!userIdentity) {
        return {
          success: false,
          message: 'Failed to retrieve user identity from token'
        };
      }

      // Create user session
      const sessionId = this.generateSessionId();
      const session: UserSession = {
        sessionId,
        webAuthToken,
        userId: this.generateUserId(userIdentity.userRecordName),
        userRecordName: userIdentity.userRecordName,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + (this.securityConfig?.sessionTimeout || 24 * 60 * 60 * 1000)), // Default 24 hours
        containerID: userIdentity.containerID || 'unknown'
      };

      this.sessions.set(sessionId, session);

      console.log(`User authenticated: ${session.userRecordName} (session: ${sessionId})`);

      return {
        success: true,
        sessionId,
        userId: session.userId,
        userRecordName: session.userRecordName,
        expiresAt: session.expiresAt
      };
    } catch (error) {
      console.error('Authentication failed:', error);
      return {
        success: false,
        message: `Authentication failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Validate existing session
   */
  async validateSession(sessionId: string): Promise<UserSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    
    // Check if session has expired
    if (new Date() > session.expiresAt) {
      this.sessions.delete(sessionId);
      console.log(`Session expired: ${sessionId}`);
      return null;
    }

    return session;
  }

  /**
   * Refresh session (extend expiry)
   */
  async refreshSession(sessionId: string): Promise<AuthResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        message: 'Session not found'
      };
    }

    // Extend session
    session.expiresAt = new Date(Date.now() + (this.securityConfig?.sessionTimeout || 24 * 60 * 60 * 1000));
    this.sessions.set(sessionId, session);

    return {
      success: true,
      sessionId,
      userId: session.userId,
      userRecordName: session.userRecordName,
      expiresAt: session.expiresAt
    };
  }

  /**
   * Revoke session (logout)
   */
  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      console.log(`Session revoked: ${sessionId} (user: ${session.userRecordName})`);
    }
  }

  /**
   * Get all active sessions for monitoring
   */
  getActiveSessions(): UserSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).filter(session => session.expiresAt > now);
  }

  /**
   * Get session by user record name
   */
  getSessionByUser(userRecordName: string): UserSession | null {
    for (const session of this.sessions.values()) {
      if (session.userRecordName === userRecordName && session.expiresAt > new Date()) {
        return session;
      }
    }
    return null;
  }

  // ==================== PRIVATE HELPER METHODS ====================

  /**
   * Generate CloudKit authentication URL for iCloud sign-in
   */
  private generateAuthUrl(): string {
    // For CloudKit Web Services, users need to authenticate through the CloudKit JS flow
    // This would typically redirect to Apple's iCloud sign-in page
    const baseUrl = 'https://www.icloud.com/signin/';
    const params = new URLSearchParams({
      service: 'cloudkit',
      referrer: process.env.CLOUDKIT_REDIRECT_URI || 'http://localhost:3000/auth/callback',
      language: 'en-us'
    });
    
    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Validate web auth token with CloudKit
   */
  private async validateWebAuthToken(token: string): Promise<boolean> {
    if (!this.cloudKitService) {
      console.warn('CloudKit service not available for token validation');
      return true; // Allow for testing without CloudKit
    }

    try {
      // Attempt to authenticate with CloudKit using the token
      return await this.cloudKitService.authenticateUser(token);
    } catch (error) {
      console.error('Token validation failed:', error);
      return false;
    }
  }

  /**
   * Get user identity from validated token
   */
  private async getUserIdentityFromToken(token: string): Promise<any> {
    if (!this.cloudKitService) {
      // Return mock identity for testing
      return {
        userRecordName: `user_${Date.now()}`,
        containerID: 'mock-container'
      };
    }

    try {
      const identity = this.cloudKitService.getUserIdentity();
      return identity || {
        userRecordName: `user_${Date.now()}`,
        containerID: 'unknown'
      };
    } catch (error) {
      console.error('Failed to get user identity:', error);
      return null;
    }
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substr(2, 9);
    return `session_${timestamp}_${randomPart}`;
  }

  /**
   * Generate consistent user ID from user record name
   */
  private generateUserId(userRecordName: string): string {
    // Create a consistent hash-like ID from the user record name
    let hash = 0;
    for (let i = 0; i < userRecordName.length; i++) {
      const char = userRecordName.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `user_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Check rate limiting for authentication attempts
   */
  private checkRateLimit(operation: string): boolean {
    if (!this.securityConfig?.rateLimiting) {
      return true; // No rate limiting configured
    }

    const now = Date.now();
    const windowMs = this.securityConfig.rateLimiting.windowMs;
    const maxRequests = this.securityConfig.rateLimiting.maxRequests;
    
    const key = `${operation}_rate_limit`;
    const requests = this.rateLimitMap.get(key) || [];
    
    // Remove old requests outside the window
    const validRequests = requests.filter(timestamp => (now - timestamp) < windowMs);
    
    // Check if we're over the limit
    if (validRequests.length >= maxRequests) {
      return false;
    }
    
    // Add current request
    validRequests.push(now);
    this.rateLimitMap.set(key, validRequests);
    
    return true;
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startSessionCleanup(): void {
    // Clean up expired sessions every 10 minutes
    setInterval(() => {
      const now = new Date();
      let expiredCount = 0;
      
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.expiresAt <= now) {
          this.sessions.delete(sessionId);
          expiredCount++;
        }
      }
      
      if (expiredCount > 0) {
        console.log(`Cleaned up ${expiredCount} expired sessions`);
      }
    }, 10 * 60 * 1000); // 10 minutes
  }
}

/**
 * Authentication middleware for validating requests
 */
export class AuthMiddleware {
  private authService: UserAuthService;
  private auditLog: Array<{ timestamp: Date; userId?: string; operation: string; success: boolean; message?: string }> = [];

  constructor(authService: UserAuthService) {
    this.authService = authService;
  }

  /**
   * Validate authentication for MCP request
   */
  async validateRequest(sessionId?: string): Promise<{ valid: boolean; session?: UserSession; error?: string }> {
    if (!sessionId) {
      return {
        valid: false,
        error: 'No session ID provided. Please authenticate first.'
      };
    }

    const session = await this.authService.validateSession(sessionId);
    if (!session) {
      this.logAudit('validate_session', false, undefined, 'Invalid or expired session');
      return {
        valid: false,
        error: 'Session invalid or expired. Please authenticate again.'
      };
    }

    this.logAudit('validate_session', true, session.userId);
    return {
      valid: true,
      session
    };
  }

  /**
   * Check if user has permission for operation
   */
  async checkPermissions(session: UserSession, operation: string, resourceId?: string): Promise<boolean> {
    // In this implementation, users can only access their own data
    // More sophisticated permission systems could be implemented here
    
    if (resourceId && !resourceId.includes(session.userId)) {
      this.logAudit('permission_check', false, session.userId, `Access denied for resource: ${resourceId}`);
      return false;
    }

    this.logAudit('permission_check', true, session.userId, `Access granted for operation: ${operation}`);
    return true;
  }

  /**
   * Log audit entry
   */
  private logAudit(operation: string, success: boolean, userId?: string, message?: string): void {
    this.auditLog.push({
      timestamp: new Date(),
      userId,
      operation,
      success,
      message
    });

    // Keep only last 1000 entries to prevent memory leaks
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }

  /**
   * Get recent audit log entries
   */
  getAuditLog(limit: number = 100): typeof this.auditLog {
    return this.auditLog.slice(-limit);
  }
}