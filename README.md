# ZenTasktic MCP Server

An MCP (Model Context Protocol) server that integrates with the ZenTasktic iOS/macOS app, implementing the ADD (Assess-Decide-Do) framework created by Dragos Roua.

## Overview

This MCP server provides AI assistance for your ZenTasktic productivity workflow while respecting the strict realm-based restrictions of the ADD framework:

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
- `assess_edit_task` - Edit task titles and descriptions
- `assess_create_project` - Create new projects
- `assess_create_idea` - Capture new ideas

### Decide Realm Operations
- `decide_assign_context` - Assign contexts to tasks/projects
- `decide_set_due_date` - Set due dates
- `decide_set_alert` - Set task alerts
- `decide_move_to_do` - Move items to Do realm

### Do Realm Operations
- `do_complete_task` - Mark tasks as completed
- `do_complete_project` - Mark projects as completed

### Query Operations
- `get_tasks_by_realm` - Filter tasks by realm
- `get_projects_by_realm` - Filter projects by realm
- `get_ideas` - Get all ideas
- `get_tasks_by_context` - Filter by context
- `get_overdue_tasks` - Find overdue items

## Installation

```bash
npm install -g @dragosroua/zentasktic-mcp-server
```

## Configuration

### Environment Variables

```bash
# Required: Your ZenTasktic CloudKit container identifier
CLOUDKIT_CONTAINER_ID=iCloud.com.dragosroua.app.zentasktic

# Required: CloudKit API token from CloudKit Dashboard
CLOUDKIT_API_TOKEN=your_api_token_here

# Optional: CloudKit environment (default: production)
CLOUDKIT_ENVIRONMENT=production
```

### CloudKit Dashboard Setup

1. Log into [CloudKit Dashboard](https://icloud.developer.apple.com/dashboard/)
2. Select your ZenTasktic container
3. Go to API Access → Server-to-Server Keys
4. Create a new JavaScript API token
5. Add your web app's domain to allowed origins
6. Copy the API token to `CLOUDKIT_API_TOKEN`

## Usage with Claude Desktop

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "zentasktic": {
      "command": "zentasktic-mcp-server",
      "env": {
        "CLOUDKIT_CONTAINER_ID": "iCloud.com.dragosroua.zentasktic",
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
git clone https://github.com/dragosroua/zentasktic-mcp-server.git
cd zentasktic-mcp-server
npm install

# Development mode
npm run dev

# Build
npm run build

# Test
npm test
```

## Architecture

```
Web App → Apple Sign-In → CloudKit Auth Token
    ↓
MCP Server → CloudKit.js → ZenTasktic Data
    ↓
ADD Framework Rules Enforcement
    ↓
AI Assistant (Claude) with Productivity Insights
```

## Security

- **Authentication Required**: All operations require valid Apple ID authentication
- **Data Isolation**: Users can only access their own ZenTasktic data
- **Domain Restrictions**: CloudKit API tokens are domain-restricted
- **Realm Enforcement**: ADD framework rules prevent unauthorized operations

## About the ADD Framework

The ADD (Assess-Decide-Do) framework was created by Dragos Roua as an alternative to GTD (Getting Things Done). It emphasizes:

- **Sequential Processing**: Items flow through realms in order
- **Cognitive Load Management**: Each realm has specific, limited functions
- **Balanced Productivity**: Maintains efficiency while preserving creativity and well-being

Learn more: [dragosroua.com](https://dragosroua.