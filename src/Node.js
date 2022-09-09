const WebSocket = require('ws');

class Node {
  constructor(manager, options, node) {
    this.manager = manager;
    this.name = options.name;
    this.host = options.host;
    this.port = options.port;
    this.password = options.password;
    this.secure = options.secure || false;
    this.url = `${this.secure ? 'wss' : 'ws'}://${this.host}:${this.port}/`;
    this.ws = null;
    this.reconnectInterval = node.reconnectInterval || 5000;
    this.reconnectTries = node.reconnectTries || 5;
    this.reconnectAttempts = 0;
    this.resumeKey = node.resumeKey || null;
    this.resumeTimeout = node.resumeTimeout || 60;
    this.connected = false;
    this.destroyed = false;
    this.stats = {
      players: 0,
      playingPlayers: 0,
      uptime: 0,
      memory: {
        free: 0,
        used: 0,
        allocated: 0,
        reservable: 0,
      },
      frameStats: {
        sent: 0,
        deficit: 0,
        nulled: 0,
      },
      cpu: {
        cores: 0,
        systemLoad: 0,
        lavalinkLoad: 0,
      },
    };
  }

  connect() {
    if (this.ws) this.ws.close();
    const headers = {
      Authorization: this.password,
      'Num-Shards': this.manager.shards || 1,
      'User-Id': this.manager.user,
      'Client-Name': config.clientName,
    };
    if (this.resumeKey) headers['Resume-Key'] = this.resumeKey;
    this.ws = new WebSocket(this.url, { headers });
    this.ws.on('open', this.open.bind(this));
    this.ws.on('error', this.error.bind(this));
    this.ws.on('message', this.message.bind(this));
    this.ws.on('close', this.close.bind(this));
  }

  disconnect() {
    if (!this.connected) return;

    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  destroy() {
    if (!this.connected) return;

    const players = this.manager.players.filter(
      (player) => player.node == this,
    );
    if (players.size) players.forEach((player) => player.destroy());
    this.ws.close(1000, 'destroy');
    this.ws.removeAllListeners();
    this.ws = null;
    this.destroyed = true;
    this.manager.nodes.delete(this.host);
    this.manager.emit('nodeDestroy', this);
  }

  reconnect() {
    this.reconnectTimeout = setTimeout(() => {
      if (this.reconnectAttempts > this.reconnectTries) {
        throw new Error(
          `[Web Socket] Unable to connect with node "${this.name}" after ${this.reconnectTries} attempts`,
        );
      }
      this.connected = false;
      this.ws.removeAllListeners();
      this.ws = null;
      this.manager.emit('nodeReconnect', this);
      this.connect();
      this.reconnectsAttempts++;
    }, this.reconnectInterval);
  }

  send(payload) {
    const data = JSON.stringify(payload);
    this.ws.send(data, (error) => {
      if (error) return error;
      return null;
    });
    this.manager.emit('raw', data, this.name);
  }

  open() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      delete this.reconnectTimeout;
    }

    if (this.resumeKey) {
      this.send({
        op: 'configureResuming',
        key: this.resumeKey.toString(),
        timeout: this.resumeTimeout,
      });
      this.manager.emit(
        'debug',
        `[Web Socket] Resuming lavalink server connection for node "${this.name}"`,
      );
    }

    this.manager.emit('nodeConnect', this);
    this.connected = true;
    this.manager.emit(
      'debug',
      `[Web Socket] Connection ready for node "${this.name}" (${this.url})`,
    );

    if (this.autoResume) {
      for (const player of this.manager.players.values()) {
        if (player.node === this) {
          player.restart();
        }
      }
    }
  }

  message(payload) {
    const packet = JSON.parse(payload);
    if (!packet.op) return;

    if (packet.op && packet.op === 'stats') {
      this.stats = { ...packet };
    }
    const player = this.manager.players.get(packet.guildId);
    if (packet.guildId && player) player.emit(packet.op, packet);
    packet.node = this;
    this.manager.emit(
      'debug',
      `[Web Socket] Lavalink server update for node "${this.name}": ${packet.op}`,
    );
  }

  close(event) {
    this.disconnect();
    this.manager.emit('nodeDisconnect', this, event);
    this.manager.emit(
      'debug',
      `[Web Socket] Connection closed for node "${this.name}" with error code : ${
        event || 'Unknown code'
      }`,
    );
    if (event !== 1000) this.reconnect();
  }

  error(event) {
    if (!event) return 'Unknown event';

    this.manager.emit(
      'debug',
      `[Web Socket] Lavalink node "${this.name}" received error code: ${
        event.code || event
      }`,
    );
    this.manager.emit('nodeError', this, event);
  }
}

module.exports = Node;
