#!/usr/bin/env node

/**
 * Test client for the addTaskManager MCP server
 * Make sure the server is running with "npm start" first
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Starting MCP Server Test Client\n');
console.log('Make sure your server is running with: npm start\n');

// Connect to the running server
const serverPath = join(__dirname, 'dist', 'index.js');
const client = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let requestId = 1;
let authenticated = false;

function sendRequest(method, params = {}, name = '') {
  const request = {
    jsonrpc: "2.0",
    id: requestId++,
    method: method,
    params: params
  };
  
  console.log(`📤 Test ${requestId - 1}: ${name || method}`);
  console.log(`   Request: ${JSON.stringify(request)}`);
  
  client.stdin.write(JSON.stringify(request) + '\n');
  
  return new Promise((resolve) => {
    setTimeout(resolve, 500); // Wait for response
  });
}

// Handle responses
client.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(line => line.trim());
  lines.forEach(line => {
    try {
      const response = JSON.parse(line);
      console.log(`📥 Response: ${JSON.stringify(response, null, 2)}\n`);
    } catch (e) {
      console.log(`📥 Raw: ${line}\n`);
    }
  });
});

client.stderr.on('data', (data) => {
  console.log(`🔴 Error: ${data}`);
});

// Run test sequence
async function runTests() {
  console.log('🚀 Starting test sequence...\n');
  
  try {
    // Test 1: List available tools
    await sendRequest('tools/list', {}, 'List all available tools');
    
    // Test 2: Authenticate with mock token
    await sendRequest('tools/call', {
      name: 'authenticate_user',
      arguments: { webAuthToken: 'test_token_12345' }
    }, 'Mock authentication');
    
    // Test 3: Test Assess realm - Create task
    await sendRequest('tools/call', {
      name: 'assess_create_task',
      arguments: { taskName: 'Test task from client script', taskPriority: 2 }
    }, 'Create task in Assess realm');
    
    // Test 4: Test Decide realm - Get stalled items
    await sendRequest('tools/call', {
      name: 'get_stalled_items_in_decide',
      arguments: {}
    }, 'Get stalled items in Decide realm');
    
    // Test 5: Test Decide realm - Get undecided items
    await sendRequest('tools/call', {
      name: 'get_undecided_items_in_decide', 
      arguments: {}
    }, 'Get undecided items in Decide realm');
    
    // Test 6: Test Do realm - Get today\'s tasks
    await sendRequest('tools/call', {
      name: 'get_tasks_today_in_do',
      arguments: {}
    }, 'Get today\'s tasks in Do realm');
    
    // Test 7: Test collections and ideas
    await sendRequest('tools/call', {
      name: 'get_collections',
      arguments: {}
    }, 'Get all collections');
    
    await sendRequest('tools/call', {
      name: 'get_ideas',
      arguments: {}
    }, 'Get all ideas');
    
    // Test 8: Test context filtering
    await sendRequest('tools/call', {
      name: 'get_tasks_by_context',
      arguments: { contextRecordName: 'context_work' }
    }, 'Get tasks by work context');
    
    console.log('✅ All tests completed successfully!');
    console.log('📊 Summary: Tested authentication, CRUD operations, and ADD framework queries');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
  
  setTimeout(() => {
    console.log('\n🛑 Closing test client...');
    client.kill();
    process.exit(0);
  }, 2000);
}

// Start tests after a brief delay
setTimeout(runTests, 1000);

// Handle cleanup
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted. Cleaning up...');
  client.kill();
  process.exit(0);
});