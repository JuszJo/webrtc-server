// File: signal-server.ts

import * as WebSocket from 'ws';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';

/**
 * WebRTC Signaling Server
 * 
 * This server facilitates the connection between WebRTC peers by:
 * 1. Allowing peers to register with unique IDs
 * 2. Relaying signaling messages (offers, answers, ICE candidates)
 * 3. Providing peer discovery
 */

interface SignalClient {
    id: string;
    socket: WebSocket.WebSocket;
    lastSeen: number;
}

interface SignalMessage {
    type: string;
    source?: string;
    target?: string;
    peerId?: string;
    offer?: RTCSessionDescriptionInit;
    answer?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
}

class SignalingServer {
    private server: http.Server;
    private wss: WebSocket.Server;
    private clients: Map<string, SignalClient> = new Map();
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private port: number;

    /**
     * Create a new signaling server
     * @param port Port to listen on
     */
    constructor(port: number = 8080) {
        this.port = port;
        this.server = http.createServer();
        this.wss = new WebSocket.WebSocketServer({ server: this.server });

        this.setupWebSocketServer();
        this.startHeartbeatCheck();
    }

    /**
     * Set up WebSocket server event handlers
     */
    private setupWebSocketServer(): void {
        this.wss.on('connection', (socket: WebSocket.WebSocket) => {
            // Generate a temporary ID until the client registers
            const tempId = uuidv4();
            
            this.log(`New connection established (temp ID: ${tempId})`);
            
            // Create a client object
            const client: SignalClient = {
                id: tempId,
                socket,
                lastSeen: Date.now()
            };
            
            // Store the client
            this.clients.set(tempId, client);
            
            // Set up event handlers for this connection
            socket.on('message', (message: string) => {
                this.handleMessage(message, client);
            });
            
            socket.on('close', () => {
                this.handleDisconnect(client);
            });
            
            socket.on('error', (error) => {
                this.log(`WebSocket error for client ${client.id}: ${error}`, 'error');
                this.handleDisconnect(client);
            });
            
            // Send a welcome message
            this.sendToClient(client, {
                type: 'welcome',
                peerId: tempId
            });
        });
        
        this.wss.on('error', (error) => {
            this.log(`WebSocket server error: ${error}`, 'error');
        });
    }

    /**
     * Handle incoming messages from clients
     * @param messageData Raw message data
     * @param client Client that sent the message
     */
    private handleMessage(messageData: string, client: SignalClient): void {
        try {
            const message: SignalMessage = JSON.parse(messageData);
            
            // Update last seen timestamp
            client.lastSeen = Date.now();
            
            switch (message.type) {
                case 'register':
                    this.handleRegister(message, client);
                    break;
                    
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    this.relayMessage(message);
                    break;
                    
                case 'get-peers':
                    this.sendPeerList(client);
                    break;
                    
                case 'heartbeat':
                    // Just update the lastSeen timestamp
                    break;
                    
                default:
                    this.log(`Unknown message type from client ${client.id}: ${message.type}`, 'warn');
            }
        } catch (error) {
            this.log(`Error parsing message from client ${client.id}: ${error}`, 'error');
        }
    }

    /**
     * Handle client registration (assigning a permanent ID)
     * @param message Registration message
     * @param client Client to register
     */
    private handleRegister(message: SignalMessage, client: SignalClient): void {
        if (!message.peerId) {
            this.log(`Invalid registration message from ${client.id}: missing peerId`, 'warn');
            return;
        }
        
        const newPeerId = message.peerId;
        
        // Check if ID is already in use
        if (this.clients.has(newPeerId) && this.clients.get(newPeerId)?.id !== client.id) {
            this.log(`Client ${client.id} tried to register with ID ${newPeerId} which is already in use`, 'warn');
            
            this.sendToClient(client, {
                type: 'error',
                message: 'Peer ID already in use'
            });
            
            return;
        }
        
        // Remove the old temporary entry
        this.clients.delete(client.id);
        
        // Update the client ID
        client.id = newPeerId;
        this.clients.set(newPeerId, client);
        
        this.log(`Client registered with ID: ${newPeerId}`);
        
        // Confirm registration
        this.sendToClient(client, {
            type: 'registered',
            peerId: newPeerId
        });
        
        // Notify all clients about the new peer
        this.broadcastPeerList();
    }

    /**
     * Relay a signaling message to its target
     * @param message Message to relay
     */
    private relayMessage(message: SignalMessage): void {
        if (!message.target) {
            this.log('Received signaling message with no target', 'warn');
            return;
        }
        
        const targetClient = this.clients.get(message.target);
        
        if (!targetClient) {
            this.log(`Cannot relay message to unknown client: ${message.target}`, 'warn');
            return;
        }
        
        this.log(`Relaying ${message.type} from ${message.source} to ${message.target}`);
        this.sendToClient(targetClient, message);
    }

    /**
     * Send a list of all peers to a client
     * @param client Client to send the peer list to
     */
    private sendPeerList(client: SignalClient): void {
        const peerIds = Array.from(this.clients.keys());
        
        this.sendToClient(client, {
            type: 'peers',
            peers: peerIds
        });
        
        this.log(`Sent peer list to client ${client.id}: ${peerIds.length} peers`);
    }

    /**
     * Broadcast the current peer list to all clients
     */
    private broadcastPeerList(): void {
        const peerIds = Array.from(this.clients.keys());
        
        this.broadcast({
            type: 'peers',
            peers: peerIds
        });
        
        this.log(`Broadcasted updated peer list: ${peerIds.length} peers`);
    }

    /**
     * Handle a client disconnection
     * @param client Client that disconnected
     */
    private handleDisconnect(client: SignalClient): void {
        this.log(`Client disconnected: ${client.id}`);
        
        // Remove the client
        this.clients.delete(client.id);
        
        // Notify other clients
        this.broadcastPeerList();
    }

    /**
     * Send a message to a specific client
     * @param client Client to send to
     * @param message Message to send
     */
    private sendToClient(client: SignalClient, message: any): void {
        try {
            if (client.socket.readyState === WebSocket.WebSocket.OPEN) {
                client.socket.send(JSON.stringify(message));
            }
        } catch (error) {
            this.log(`Error sending message to client ${client.id}: ${error}`, 'error');
            this.handleDisconnect(client);
        }
    }

    /**
     * Broadcast a message to all connected clients
     * @param message Message to broadcast
     */
    private broadcast(message: any): void {
        const messageStr = JSON.stringify(message);
        
        for (const client of this.clients.values()) {
            try {
                if (client.socket.readyState === WebSocket.WebSocket.OPEN) {
                    client.socket.send(messageStr);
                }
            } catch (error) {
                this.log(`Error broadcasting to client ${client.id}: ${error}`, 'warn');
            }
        }
    }

    /**
     * Start a periodic check for stale connections
     */
    private startHeartbeatCheck(): void {
        const HEARTBEAT_INTERVAL = 30000; // 30 seconds
        const MAX_IDLE_TIME = 90000;      // 90 seconds
        
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            
            for (const [id, client] of this.clients.entries()) {
                if (now - client.lastSeen > MAX_IDLE_TIME) {
                    this.log(`Client ${id} timed out (inactive for ${Math.floor((now - client.lastSeen) / 1000)}s)`, 'warn');
                    
                    try {
                        client.socket.terminate();
                    } catch (error) {
                        // Ignore errors when terminating
                    }
                    
                    this.clients.delete(id);
                }
            }
            
            // If clients were removed, broadcast an updated peer list
            this.broadcastPeerList();
        }, HEARTBEAT_INTERVAL);
    }

    /**
     * Start the server
     * @returns Promise that resolves when the server is listening
     */
    public start(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(this.port, () => {
                this.log(`Signaling server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Stop the server
     */
    public stop(): void {
        this.log('Stopping signaling server');
        
        // Clear the heartbeat interval
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Close all connections
        for (const client of this.clients.values()) {
            try {
                client.socket.terminate();
            } catch (error) {
                // Ignore errors during shutdown
            }
        }
        
        this.clients.clear();
        
        // Close the server
        this.wss.close();
        this.server.close();
    }

    /**
     * Log a message with optional level
     * @param message Message to log
     * @param level Log level (default: 'info')
     */
    private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        const timestamp = new Date().toISOString();
        const formattedMessage = `[${timestamp}] ${message}`;
        
        switch (level) {
            case 'warn':
                console.warn(formattedMessage);
                break;
            case 'error':
                console.error(formattedMessage);
                break;
            default:
                console.log(formattedMessage);
        }
    }
}

// Create and start a server instance when this file is run directly
if (require.main === module) {
    const PORT = parseInt(process.env.PORT || '8080', 10);
    const server = new SignalingServer(PORT);
    
    server.start().catch((error) => {
        console.error(`Failed to start signaling server: ${error}`);
        process.exit(1);
    });
    
    // Handle graceful shutdown
    const shutdown = () => {
        console.log('Shutting down gracefully...');
        server.stop();
        process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// Export the class for use in other files
export default SignalingServer;