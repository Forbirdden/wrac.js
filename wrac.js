/**
 * wrac.js - WRACv2.0 Protocol WebSocket Client Library
 * Made by Forbirdden (2025) MIT license
 *
 * Provides a simple interface for connecting to wRAC(s) chat servers, sending messages,
 * user registration, reading messages, and requesting server info.
 * 
 * Usage:
 *   const client = new WRAC('ws://server:port');
 *   client.on('open', () => { ... });
 *   client.on('messages', (messages) => { ... });
 *   client.connect();
 */

class WRAC {
    /**
     * @param {string} url - WebSocket URL for wRAC or wRACs server (ws:// or wss://)
     */
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.events = {};
        this._pendingResolve = {};
        this._lastReceivedMessages = [];
        this._openRequested = false;
    }

    /**
     * Connect to the server.
     */
    connect() {
        if (this.ws && this.ws.readyState === 1) return;
        if (this.ws) { this.ws.onclose = null; this.ws.close(); }
        this._openRequested = true;
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = "arraybuffer";
        this.ws.onopen = () => {
            if (this._openRequested) this._emit('open');
        };
        this.ws.onerror = (e) => {
            this._emit('error', e);
        };
        this.ws.onclose = (e) => {
            this._emit('close', e);
        };
        this.ws.onmessage = (event) => {
            this._handleMessage(event.data);
        };
    }

    /**
     * Disconnect from the server.
     */
    disconnect() {
        if (this.ws) {
            this._openRequested = false;
            this.ws.close();
        }
    }

    /**
     * Event subscription
     * @param {string} event - Event name
     * @param {function} callback - Callback function
     */
    on(event, callback) {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(callback);
    }

    /**
     * Event unsubscription
     * @param {string} event
     * @param {function} callback
     */
    off(event, callback) {
        if (!this.events[event]) return;
        this.events[event] = this.events[event].filter(cb => cb !== callback);
    }

    /**
     * Send a plain message (unauthorized, visible as "unauth").
     * @param {string} message
     */
    sendMessage(message) {
        const enc = new TextEncoder();
        const msg = enc.encode(message);
        const arr = new Uint8Array(1 + msg.length);
        arr[0] = 0x01;
        arr.set(msg, 1);
        this._send(arr);
    }

    /**
     * Send a message as an authorized user.
     * @param {string} username
     * @param {string} password
     * @param {string} message
     * @returns {Promise<"ok"|"no_user"|"bad_pass">}
     */
    sendAuthMessage(username, password, message) {
        const enc = new TextEncoder();
        const uname = enc.encode(username);
        const pass = enc.encode(password);
        const msg = enc.encode(message);
        // 0x02 uname \n pass \n msg
        const arr = new Uint8Array(1 + uname.length + 1 + pass.length + 1 + msg.length);
        arr[0] = 0x02;
        arr.set(uname, 1);
        arr[1 + uname.length] = 10;
        arr.set(pass, 1 + uname.length + 1);
        arr[1 + uname.length + 1 + pass.length] = 10;
        arr.set(msg, 1 + uname.length + 1 + pass.length + 1);

        return new Promise((resolve) => {
            this._pendingResolve["sendAuthMessage"] = resolve;
            this._send(arr);
        });
    }

    /**
     * Register a user.
     * @param {string} username
     * @param {string} password
     * @returns {Promise<"ok"|"username_taken">}
     */
    register(username, password) {
        const enc = new TextEncoder();
        const uname = enc.encode(username);
        const pass = enc.encode(password);
        // 0x03 uname \n pass
        const arr = new Uint8Array(1 + uname.length + 1 + pass.length);
        arr[0] = 0x03;
        arr.set(uname, 1);
        arr[1 + uname.length] = 10;
        arr.set(pass, 1 + uname.length + 1);

        return new Promise((resolve) => {
            this._pendingResolve["register"] = resolve;
            this._send(arr);
        });
    }

    /**
     * Request the total size (in bytes) of all messages on the server.
     * @returns {Promise<number>}
     */
    getMessageSize() {
        return new Promise((resolve) => {
            this._pendingResolve["getMessageSize"] = resolve;
            this._send(new Uint8Array([0x00]));
        });
    }

    /**
     * Read all messages from the server.
     * @returns {Promise<string[]>}
     */
    readAllMessages() {
        return new Promise((resolve) => {
            this._pendingResolve["readAllMessages"] = resolve;
            this._send(new Uint8Array([0x00, 0x01]));
        });
    }

    /**
     * Read new messages since last known size.
     * @param {number} lastSize
     * @returns {Promise<string[]>}
     */
    readChunkedMessages(lastSize) {
        // 0x00 0x02 <last_size ASCII>
        const lastSizeStr = String(lastSize);
        const enc = new TextEncoder();
        const sizeEnc = enc.encode(lastSizeStr);
        const arr = new Uint8Array(2 + sizeEnc.length);
        arr[0] = 0x00;
        arr[1] = 0x02;
        arr.set(sizeEnc, 2);

        return new Promise((resolve) => {
            this._pendingResolve["readChunkedMessages"] = resolve;
            this._send(arr);
        });
    }

    /**
     * Request server info (protocol version and server name).
     * @returns {Promise<{version: number, name: string}>}
     */
    getServerInfo() {
        return new Promise((resolve) => {
            this._pendingResolve["getServerInfo"] = resolve;
            this._send(new Uint8Array([0x69]));
        });
    }

    // --- Internal ---

    _emit(event, ...args) {
        if (this.events[event]) {
            for (const cb of this.events[event]) cb(...args);
        }
    }

    _send(data) {
        if (!this.ws || this.ws.readyState !== 1) throw new Error("WebSocket is not open");
        this.ws.send(data);
    }

    _handleMessage(data) {
        if (typeof data === "string") return; // protocol uses binary only

        const buf = new Uint8Array(data);

        // Handle single-byte error responses for sendAuthMessage/register
        if (buf.length === 1) {
            switch (buf[0]) {
                case 0x01:
                    if (this._pendingResolve["sendAuthMessage"]) {
                        this._pendingResolve["sendAuthMessage"]("no_user");
                        delete this._pendingResolve["sendAuthMessage"];
                        return;
                    }
                    if (this._pendingResolve["register"]) {
                        this._pendingResolve["register"]("username_taken");
                        delete this._pendingResolve["register"];
                        return;
                    }
                    return;
                case 0x02:
                    if (this._pendingResolve["sendAuthMessage"]) {
                        this._pendingResolve["sendAuthMessage"]("bad_pass");
                        delete this._pendingResolve["sendAuthMessage"];
                        return;
                    }
                    return;
            }
        }

        // ASCII decode
        const str = new TextDecoder().decode(buf).trim();

        // Check if we're expecting a message size (getMessageSize)
        if (/^\d+$/.test(str) && this._pendingResolve["getMessageSize"]) {
            this._pendingResolve["getMessageSize"](parseInt(str, 10));
            delete this._pendingResolve["getMessageSize"];
            return;
        }

        // Check if we're expecting all messages (readAllMessages/readChunkedMessages)
        if ((this._pendingResolve["readAllMessages"] || this._pendingResolve["readChunkedMessages"])) {
            // Split by newline, filter empty lines
            const lines = str.split('\n').filter(Boolean);
            if (this._pendingResolve["readAllMessages"]) {
                this._pendingResolve["readAllMessages"](lines);
                delete this._pendingResolve["readAllMessages"];
            }
            if (this._pendingResolve["readChunkedMessages"]) {
                this._pendingResolve["readChunkedMessages"](lines);
                delete this._pendingResolve["readChunkedMessages"];
            }
            this._lastReceivedMessages = lines;
            this._emit('messages', lines);
            return;
        }

        // Server info: first byte is version, rest is server name
        if (this._pendingResolve["getServerInfo"] && buf.length > 1) {
            const version = buf[0];
            const name = new TextDecoder().decode(buf.slice(1));
            this._pendingResolve["getServerInfo"]({ version, name });
            delete this._pendingResolve["getServerInfo"];
            return;
        }

        // By default, treat as messages & emit 'messages'
        const lines = str.split('\n').filter(Boolean);
        this._lastReceivedMessages = lines;
        this._emit('messages', lines);
    }
}

// Export for node/browser
if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
    module.exports = WRAC;
} else {
    window.WRAC = WRAC;
}
