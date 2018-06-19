'use strict';

const WebSocket = require('ws');
const logger = require('./logger');

class WebSocketMessage {

    /**
     * 
     * @param {{topic:string,data?:Object,message?:string}|Object} data 
     */
    constructor(data, fromConnection) {
        data = typeof (data) === 'string' ? JSON.parse(data) : data;
        this._topic = topicsManager.getOrCreateTopic(data.topic || 'info');
        this._type = data.type || 'message';
        this._message = data.data || data.message || data;
        this._original = data;
        this._from = fromConnection || data.from || data.sender;
        this._id = Math.ceil(Math.random() * 10000000) + "" + new Date().getTime();
        logger.log('New WebSocket message has been created. id: %s, type: %s, message: %s, topic: %s', this.id, this.type, this.message, this.topic.name);
    }

    get topic() { return this._topic; }
    get message() { return this._message; }
    get original() { return this._original; }
    get type() { return this._type; }
    get from() { return this._from; }
    get id() { return this._id; }

    toString() {
        return this.message;
    }

    toJSON() {
        return { topic: this.topic.name, message: this.message, type: this.type, from: this.from ? this.from.name : null, id: this.id };
    }

    static create(data, defaults) {
        defaults = defaults || {};
        const type = defaults.type || data.type || null;
        const message = data instanceof WebSocketMessage ? data : new WebSocketMessage({ type, ...defaults, ...(typeof (data) === 'object' ? (data instanceof Array ? { data } : data) : { message: data }) });
        return message;
    }

}


class Topic {

    constructor(name) {
        logger.log('New topic has been created. %s', name);
        this._name = name;
        this._connections = new Map();
        this._data = [];
        setInterval(() => this.publish('Interval message'), 20000);
    }

    subscribe(connection) {
        if (!this.can('subscribe', connection)) {
            throw 'Connection cannot subscribe to topic';
        }
        this.connections.set(connection.name, connection);
        logger.log('Connection %s subscribed to topic %s', connection.name, this.name);
    }

    unsubscribe(connection) {
        if (!this.can('unsubscribe', connection)) {
            throw 'Connection cannot subscribe to topic';
        }
        this.connections.delete(connection.name);
        logger.log('Connection %s unsubscribed from topic %s', connection.name, this.name);
    }

    get connections() { return this._connections; }
    get name() { return this._name; }

    can(verb, connection) {
        try {
            switch (verb) {
                case 'subscribe':
                case 'unsubscribe':
                case 'publish':
                case 'read':
                    return !!connection.authenticated;
                default:
                    throw 'Unauthorized';
            }
        } catch (e) {
            logger.error('Connection %s cannot %s to topic %s. %s', connection.name, verb, this.name, e);
            return false;
        }
    }

    publish(data, fromConnection) {
        data = WebSocketMessage.create(data, { topic: this.name });
        if (fromConnection && !this.can('publish', fromConnection)) {
            throw 'Cannot publish to this topic';
        }
        this._data.push(data);
        logger.log('Publishing message %s to all %s subscribers to topic %s', data.id, this.connections.size, this.name);
        [...this.connections.values()].forEach(connection => connection.send(data));
    }

    data(connection) {
        if (!connection || !this.can('read', connection)) {
            throw 'Cannot read from this topic';
        }
        return this._data;
    }

}

class User {
    constructor(name) {
        this.name = name;
    }
}

class Connection {

    constructor(name, connection) {
        this._name = name;
        this._connection = connection;
        this._authenticated = false;
        this._topics = new Map();
        this._user = null;
        connection.on('message', message => this.handleMessage(new WebSocketMessage(message, this)));
        connection.on('disconnect', () => this.disconnecting(true));
        connection.on('close', () => this.disconnecting(true));
    }

    get name() { return this._name; }
    get connection() { return this._connection; }
    get authenticated() { return !!this.user; }
    get user() { return this._user; }
    get topics() { return this._topics; }

    disconnect(silent) {
        this.disconnecting(!!silent);
        this.connection.disconnect();
    }

    disconnecting(silent) {
        if (!silent) {
            this.send('Unsubscribing from topics', 'disconnect');
        }
        this.unsubscribeFromTopics();
        if (!silent) {
            silent && this.send('Disconnecting', 'disconnect');
        }
    }

    /**
     * 
     * @param {WebSocketMessage} message The message to be handled
     */
    handleMessage(message) {
        logger.log('Handling new message received on connection %s', this.name);
        const type = message.type.toLowerCase();
        if (!this.authenticated && type === 'authenticate') {
            return this.tryToAuthenticate(message);
        }
        if (!message.topic.can(type, this)) {
            logger.log('Operation %s is not authorized for connection %s', type, this.name);
            return this.send('Operation ' + type + ' is not authorized');
        }
        try {
            switch (type) {
                case 'subscribe':
                    this.subscribeTopTopic(message.topic);
                    break;
                case 'unsubscribe':
                    this.unsubscribeFromTopic(message.topic);
                    break;
                case 'message':
                    const topic = topicsManager.getOrCreateTopic(message.topic);
                    this.subscribeTopTopic(topic);
                    topic.publish(message, this);
                    break;
                case 'data':
                    topicsManager.getOrCreateTopic(message.topic).data(this).forEach(message => this.send(message));
                    break;
                case 'status':
                    return this.sendStatus();
                default:
                    return this.send('Operation is not defined');
            }
        } catch (e) {
            logger.log(e);
        }
    }

    send(data, type) {
        data = WebSocketMessage.create(data, { type });
        logger.log('Sending %s to connection %s', data.type + ':' + data.id, this.name);
        try {
            this.connection.send(JSON.stringify(data.toJSON()));
        } catch (e) {
            logger.error(e);
            logger.log('Removing connection %s', this.name);
            this.unsubscribeFromTopics();
            webSocketConnections.removeConnection(this);
        }
    }

    subscribeTopTopic(topic) {
        topic = topicsManager.getOrCreateTopic(topic);
        logger.log('Subscribing connection %s to topic', this.name, topic.name);
        topic.subscribe(this);
        this.topics.set(topic.name, topic);
    }

    unsubscribeFromTopic(topic) {
        topic = topicsManager.getOrCreateTopic(topic);
        logger.log('Unsubscribing connection %s from topic', this.name, topic.name);
        topic.unsubscribe(this);
        this.topics.delete(topic.name);
    }

    unsubscribeFromTopics() {
        logger.log('Unsubscribing connection %s from all topics', this.name);
        this.topics.forEach(topic => this.unsubscribeFromTopic(topic));
    }

    /**
     * 
     * @param {WebSocketMessage} message 
     */
    tryToAuthenticate(message) {
        logger.log('Trying to authenticate the user');
        if (!message.type.toLowerCase() === 'authenticate') {
            throw 'User cannot be authenticated';
        }
        const user = message.user || message.message;
        if (!user) {
            throw 'User cannot be authenticated';
        }
        logger.log('User authenticated: %s', user);
        this._user = new User(user);
        this.sendStatus();
        return this.user;
    }

    sendStatus() {
        this.send({ user: this.user, authenticated: this.authenticated, topics: [...this.topics.keys()], name: this.name }, 'status');
    }

}

const topicsManager = new (class TopicManager {

    constructor() {
        this._topics = new Map();
    }

    /**
     * Creates a new topic or retrieves it if exists
     * @param {Topic|string} topic the name of the topic or the topic object to be added
     */
    getOrCreateTopic(topic) {

        /**
         * Creates new topic if the topic parameter is string, or return the topic param as is
         * @param {Topic|strinc} topic A name of the topic or the topic itself
         */
        function getTopic(topic) {
            return typeof (topic) === 'string' ? new Topic(topic) : topic;
        }

        /**
         * Creates a new topic and adds it to the list
         * @param {Topic|string} topic Creates and adds a topic to the topics list
         */
        function createTopic(topic) {
            topic = getTopic.call(this, topic);
            this._topics.set(topic.name, topic);
            return topic;
        }

        const topicName = typeof (topic) === 'string' ? topic : topic.name;
        return this._topics.has(topicName) ? this._topics.get(topicName) : (createTopic.call(this, topic));

    }

    deleteTopic(topic) {
        topic = this.getOrCreateTopic(topic);
        [...topic.connections.values()].forEach(connection => connection.unsubscribe(topic));
        this._topics.delete(topic.name);
    }

})();

const webSocketConnections = new (class WebSocketConnections {

    constructor() {
        this._connections = new Map();
    }

    get connections() { return this._connections; }

    /**
     * 
     * @param {Connection} connection 
     */
    addConnection(connection) {
        this._connections.set(connection.name, connection);
        logger.log('Added connection %s to connections pool. Total %s', this.name, this.connections.size);
    }

    /**
     * 
     * @param {Connection} connection 
     */
    removeConnection(connection) {
        this._connections.delete(connection.name);
        logger.log('Removed connection %s from connections pool. Remaining %s', this.name, this.connections.size);
    }

})();

const webSocketServer = new (class WebSocketServer {

    constructor() {
        this._connectionsMgr = webSocketConnections;
        this._topicsMgr = topicsManager;
        this.startServer();
    }

    get port() { return 3003; }

    get connectionsManager() { return this._connectionsMgr; }

    get topicsManager() { return this._topicsMgr; }

    get server() { return this._server; }

    startServer() {
        logger.log('WebSocket server is listening on ws://localhost:%s', this.port)
        const server = new WebSocket.Server({ port: this.port });
        this._server = server;
        server.on('connection', wsConnection => this.createConnection(wsConnection));
    }

    createConnection(wsConnection) {
        const connectionName = 'c' + this.connectionsManager.connections.size + Math.ceil(Math.random() * 10000000) + "" + new Date().getTime();
        logger.log('New incoming connection %s', connectionName);
        const connection = new Connection(connectionName, wsConnection);
        this.connectionsManager.addConnection(connection);
    }

})();

module.exports = webSocketServer;
