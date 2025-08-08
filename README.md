# addTaskManager MCP Server

An MCP (Model Context Protocol) server that integrates with the addTaskManager iOS/macOS app, implementing the ADD (Assess-Decide-Do) framework created by Dragos Roua.

## Overview

This MCP server provides AI assistance for your addTaskManager productivity workflow while respecting the strict realm-based restrictions of the ADD framework:

- **Assess Realm**: Create and edit tasks/projects/ideas, but cannot assign contexts or due dates
- **Decide Realm**: Assign contexts, due dates, and alerts, but cannot edit content
- **Do Realm**: Mark items as complete only (read-only otherwise)

## Features

### Authentication
- Secure Apple Sign-In integration
- CloudKit.js authentication for personal data access
- User-specific data isolation

### Assess Realm Operations
- `assess_create_task` - Create new tasks with editable content
- `assess_edit_task` - Edit task content
- `assess_create_project` - Create new projects
- `assess_edit_project` - Edit project title
- `assess_create_idea` - Capture new ideas
- `assess_create_collection` - Create new collection
- `assess_create_context` - Create new context
- `assess_edit_idea` - Edit idea title
- `assess_add_task_to_project` - Add an existing task to a project
- `assess_add_task_to_idea` - Add an existing task to an idea
- `assess_remove_task_from_project` - Remove a task assigned to a project
- `assess_remove_task_from_idea` - Remove a task assigned to an idea
- `assess_archive_task_to_collection` - Archive a task to an existing collection
- `assess_archive_project_to_collection` - Archive a project to an existing collection


### Decide Realm Operations
- `decide_assign_context` - Assign contexts to tasks/projects
- `decide_set_project_interval` - Set a project interval (start date and end date)
- `decide_set_task_due_date` - Set due date to a task
- `decide_set_task_alert` - Set task alerts
- `decide_move_task_to_do` - Move task to Do realm
- `decide_move_task_to_assess_from_decide` - Move task to Assess realm
- `decide_move_project_to_do` - Move project to Do realm
- `decide_move_project_to_assess_from_decide` - Move project to Assess realm

### Do Realm Operations
- `do_mark_task_as_done` - Mark tasks as completed
- `do_mark_project_as_done` - Mark projects as completed

### Query Operations
- `get_tasks_by_realm` - Filter tasks by realm
- `get_projects_by_realm` - Filter projects by realm
- `get_ideas` - Get all ideas
- `get_collections` - Get all collections
- `get_tasks_by_context` - Filter by context
- `get_stalled_items_in_decide` - Find stalled items (task + projects) in Decide
- `get_undecided_items_in_decide` - Find undecided items (task + projects) in Decide
- `get_ready_items_in_decide` - Find ready to do items (task + projects) in Decide
- `get_tasks_today_in_do` - Find tasks done today in Do
- `get_tasks_tomorrow_in_do` - Find tasks done tomorrow in Do
- `get_tasks_soon_in_do` - Find tasks done soon in Do
- `get_tasks_overdue_in_do` - Find tasks overdue in Do

### General Operations
- `moveToRealm` - Move a task or project to any realm (assess/decide/do)

## Installation

### From npm (Coming Soon)

```bash
npm install -g @dragosroua/addtaskmanager-mcp-server
```

### From Source

```bash
git clone https://github.com/dragosroua/addtaskmanager-mcp-server.git
cd addtaskmanager-mcp-server
npm install
npm run build
```

## Configuration

### Environment Variables

The server supports both development and production configurations. Copy `.env.example` to `.env` and configure:

```bash
# Environment
NODE_ENV=production  # or development
# FORCE_CLOUDKIT=true  # Force CloudKit in development

# CloudKit Configuration (Required)
CLOUDKIT_CONTAINER_ID=iCloud.com.yourapp.zentasktic
CLOUDKIT_API_TOKEN=your_api_token_here
CLOUDKIT_ENVIRONMENT=production  # or development
CLOUDKIT_AUTH_METHOD=user  # or server-to-server

# Security Configuration (Production)
ENCRYPTION_KEY=your_32_byte_encryption_key_here
ALLOWED_ORIGINS=https://yourapp.com,https://localhost:3000
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
AUDIT_LOGGING=true
SESSION_TIMEOUT_MS=86400000  # 24 hours

# Optional: For server-to-server authentication
# CLOUDKIT_SERVER_KEY=your_server_key_id
# CLOUDKIT_PRIVATE_KEY_PATH=/path/to/private/key.p8
# CLOUDKIT_PRIVATE_KEY_PASSPHRASE=your_passphrase

# Optional: Custom redirect URI
# CLOUDKIT_REDIRECT_URI=https://yourapp.com/auth/callback
```

### CloudKit Dashboard Setup

1. Log into [CloudKit Dashboard](https://icloud.developer.apple.com/dashboard/)
2. Select your addTaskManager container
3. Go to API Access → Server-to-Server Keys
4. Create a new JavaScript API token
5. Add your web app's domain to allowed origins
6. Copy the API token to `CLOUDKIT_API_TOKEN`

## Usage with Claude Desktop

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "addTaskManager": {
      "command": "node",
      "args": ["/path/to/addtaskmanager-mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "production",
        "CLOUDKIT_CONTAINER_ID": "iCloud.com.yourapp.zentasktic",
        "CLOUDKIT_API_TOKEN": "your_api_token_here",
        "CLOUDKIT_ENVIRONMENT": "production",
        "ENCRYPTION_KEY": "your_32_byte_encryption_key_here"
      }
    }
  }
}
```

For development:

```json
{
  "mcpServers": {
    "addTaskManager": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/path/to/addtaskmanager-mcp-server",
      "env": {
        "NODE_ENV": "development",
        "CLOUDKIT_CONTAINER_ID": "iCloud.com.yourapp.zentasktic",
        "CLOUDKIT_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

## Usage with Web App

1. Implement Apple Sign-In on your web app
2. Get user's CloudKit web auth token
3. Call `authenticate_user` with the token
4. Start using realm-specific operations

Example authentication flow:
```javascript
// After Apple Sign-In success
const authResult = await mcp.callTool('authenticate_user', {
  webAuthToken: user.cloudKitWebAuthToken
});

// Now you can use other tools
const tasks = await mcp.callTool('get_tasks_by_realm', {
  realm: 'assess'
});
```

## ADD Framework Rules

The server enforces these ADD framework restrictions:

### Assess Realm
- ✅ Create/edit task content (title, body)
- ✅ Create projects and ideas
- ❌ Assign contexts or due dates
- ❌ Mark as complete

### Decide Realm  
- ✅ Assign contexts to tasks/projects
- ✅ Set due dates and alerts
- ✅ Move items between realms
- ❌ Edit task/project content
- ❌ Mark as complete

### Do Realm
- ✅ Mark tasks/projects as complete
- ✅ View items (read-only)
- ❌ Edit any content
- ❌ Assign contexts or dates

## Development

```bash
# Clone and install
git clone https://github.com/dragosroua/addtaskmanager-mcp-server.git
cd addtaskmanager-mcp-server
npm install

# Setup environment
cp .env.example .env
# Edit .env with your CloudKit credentials

# Development mode with TypeScript compilation
npm run dev

# Production build
npm run build

# Start built server
npm start

# Code quality
npm run lint
npm run typecheck

# Test (when available)
npm test
```

### Project Structure

```
src/
├── config/
│   └── production.ts          # Environment-based configuration
├── services/
│   ├── CloudKitService.ts     # CloudKit integration
│   └── UserAuthService.ts     # User authentication
├── types/
│   └── cloudkit.ts           # TypeScript type definitions
└── index.ts                  # Main MCP server implementation
```

### Development Notes

- Uses ESM modules (type: "module" in package.json)
- TypeScript compiled to `dist/` directory
- Supports both development and production CloudKit environments
- Environment-based configuration with security considerations
- Comprehensive type definitions for CloudKit integration

## Architecture

```
AI Assistant (Claude Desktop) → MCP Server → CloudKit Services
                                    ↓
                            Environment Config
                            Security Controls
                            User Authentication
                                    ↓
                            ADD Framework Rules
                                    ↓
                            addTaskManager Data
                            (User's iCloud Container)
```

### Component Overview

- **MCP Server**: Model Context Protocol server implementation
- **CloudKit Integration**: Production-ready CloudKit Web Services client
- **Authentication**: Apple ID-based user authentication with session management
- **Security Layer**: Encryption, rate limiting, audit logging, CORS protection
- **ADD Framework**: Realm-based business logic enforcement
- **Type Safety**: Comprehensive TypeScript definitions

## Security

- **Environment-Based Security**: Different security profiles for development/production
- **User Authentication**: Apple ID authentication with CloudKit web auth tokens
- **Session Management**: Secure session handling with configurable timeouts
- **Data Encryption**: Configurable encryption keys for sensitive data
- **Rate Limiting**: Configurable request rate limiting with user-specific limits
- **CORS Protection**: Configurable allowed origins for web app integration
- **Audit Logging**: Comprehensive operation logging for security monitoring
- **Data Isolation**: Users can only access their own addTaskManager data
- **Realm Enforcement**: ADD framework rules prevent unauthorized operations

## About the ADD Framework

The ADD (Assess-Decide-Do) framework was created by Dragos Roua as an alternative to GTD (Getting Things Done). It emphasizes:

- **Sequential Processing**: Items flow through realms in order
- **Cognitive Load Management**: Each realm has specific, limited functions
- **Balanced Productivity**: Maintains efficiency while preserving creativity and well-being

Learn more: [dragosroua.com](https://dragosroua.com)