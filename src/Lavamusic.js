const { EventEmitter } = require('node:events');
const undici = require('undici');
const Player = require('./Player');
const Node = require('./Node');
const Response = require('./guild/Response');
const Spotify = require('./plugins/Spotify');
const AppleMusic = require('./plugins/AppleMusic');
const Deezer = require('./plugins/Deezer');

class Lavamusic extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super();
    if (!client) {
      throw new Error('A valid client wasn\'t provided.');
    }
    if (!nodes) {
      throw new Error('A lavalink node wasn\'t provided.');
    }

    this.client = client;
    this._nodes = nodes;
    this.nodes = new Map();
    this.players = new Map();
    this.voiceStates = new Map();
    this.voiceServers = new Map();
    this.ready = false;
    this.user = null;
    this.options = options;
    this.sendData = null;
    this.spotify = new Spotify(this, this.options);
    this.apple = new AppleMusic(this, this.options);
    this.apple.requestToken();
    this.deezer = new Deezer(this, this.options);
  }

  init(client) {
    if (this.ready) return this;

    this.sendData = (data) => {
      const guild = client.guilds.cache.get(data.d.guild_id);
      if (guild) guild.shard.send(data);
    };

    client.on('raw', async (packet) => {
      this.packetUpdate(packet);
    });

    this._nodes.forEach((node) => this.addNode(node));
    this.ready = true;
  }

  addNode(options) {
    const node = new Node(this, options, this.options);
    if (options.name) {
      this.nodes.set(options.name || options.host, node);
      node.connect();
      return node;
    }
    this.nodes.set(options.host, node);
    node.connect();
    return node;
  }

  removeNode(identifier) {
    if (!identifier) {
      throw new Error(
        'Expected a node identifier as a parameter for this method',
      );
    }
    
    const node = this.nodes.get(identifier);
    if (!node) return;
    node.destroy();
    this.nodes.delete(identifier);
  }

  get leastUsedNode() {
    return [...this.nodes.values()]
      .filter((node) => node.connected)
      .sort((a, b) => {
        const aLoad = a.stats.cpu
          ? (a.stats.cpu.systemLoad / a.stats.cpu.cores) * 100
          : 0;
        const bLoad = b.stats.cpu
          ? (b.stats.cpu.systemLoad / b.stats.cpu.cores) * 100
          : 0;
        return aLoad - bLoad;
      });
  }

  getNode(identifier = 'best') {
    if (!this.nodes.size) throw new Error('No nodes are avaliable');
    if (identifier === 'best') return this.leastUsedNodes;

    const node = this.nodes.get(identifier);
    if (!node) throw new Error('The node identifier you provided is not found');
    if (!node.connected) node.connect();
    return node;
  }

  checkConnection(options) {
    const { guildId, voiceChannelId, textChannelId } = options;
    if (!guildId) {
      throw new Error('A Guild ID must be provided');
    }
    if (!voiceChannelId) {
      throw new Error('A Voice Channel ID must be provided');
    }
    if (!textChannelId) {
      throw new Error('A Text Channel ID must be a provided');
    }

    if (typeof guildId !== 'string') {
      throw new Error('Guild ID must be a snowflake');
    }
    if (typeof voiceChannelId !== 'string') {
      throw new Error(
        'Voice Channel ID must be a snowflake',
      );
    }
    if (typeof textChannelId !== 'string') {
      throw new Error(
        'Text Channel ID must be a snowflake',
      );
    }
  }

  connect(options) {
    this.checkConnection(options);
    const player = this.players.get(options.guildId);
    if (player) return player;

    if (this.leastUsedNodes.length === 0) {
      throw new Error('No nodes are avaliable');
    }
    const node = this.nodes.get(
      this.leastUsedNodes[0].name || this.leastUsedNodes[0].host,
    );
    if (!node) throw new Error('No nodes are avalible');

    return this.createPlayer(node, options);
  }

  removeConnection(guildId) {
    this.players.get(guildId)?.destroy();
  }

  createPlayer(node, options) {
    if (this.players.has(options.guildId)) {
      return this.players.get(options.guildId);
    }

    const player = new Player(this, node, options);
    this.players.set(options.guildId, player);
    player.connect(options);
    return player;
  }

  setServersUpdate(data) {
    const guild = data.guild_id;
    this.voiceServers.set(guild, data);
    const server = this.voiceServers.get(guild);
    const state = this.voiceStates.get(guild);
    if (!server) return false;
    const player = this.players.get(guild);
    if (!player) return false;

    player.updateSession({
      sessionId: state ? state.session_id : player.voiceUpdateState.sessionId,
      event: server,
    });

    return true;
  }

  setStateUpdate(data) {
    if (data.user_id !== this.user) return;
    if (data.channel_id) {
      const guild = data.guild_id;

      this.voiceStates.set(data.guild_id, data);
      const server = this.voiceServers.get(guild);
      const state = this.voiceStates.get(guild);
      if (!server) return false;
      const player = this.players.get(guild);
      if (!player) return false;
      player.updateSession({
        sessionId: state ? state.session_id : player.voiceUpdateState.sessionId,
        event: server,
      });

      return true;
    }
    this.voiceServers.delete(data.guild_id);
    this.voiceStates.delete(data.guild_id);
  }

  packetUpdate(packet) {
    if (!['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(packet.t)) {
      return;
    }
    const player = this.players.get(packet.d.guild_id);
    if (!player) return;

    if (packet.t === 'VOICE_SERVER_UPDATE') {
      this.setServersUpdate(packet.d);
    }
    if (packet.t === 'VOICE_STATE_UPDATE') {
      this.setStateUpdate(packet.d);
    }
  }

  async resolve(query, source) {
    const node = this.leastUsedNodes[0];
    if (!node) throw new Error('No nodes are available');
    const regex = /^https?:\/\//;

    if (regex.test(query)) {
      return this.fetchURL(node, query, source);
    } else {
      return this.fetchTrack(node, query, source);
    }
  }

  async fetchURL(node, track) {
    if (this.spotify.check(track)) {
      return await this.spotify.resolve(track);
    } else if (this.apple.check(track)) {
      return await this.apple.resolve(track);
    } else if (this.deezer.check(track)) {
      return await this.deezer.resolve(track);
    } else {
      const result = await this.fetch(
        node,
        'loadtracks',
        `identifier=${encodeURIComponent(track)}`,
      );
      if (!result) throw new Error('No tracks found');
      return new Response(result);
    }
  }

  async fetchTrack(node, query, source) {
    switch (source) {
      case 'spotify': {
        return this.spotify.fetch(query);
      }
      case 'applemusic': {
        return this.apple.fetch(query);
      }
      case 'deezer': {
        return this.deezer.fetch(query);
      }
      default: {
        const track = `${source || 'ytsearch'}:${query}`;
        const result = await this.fetch(
          node,
          'loadtracks',
          `identifier=${encodeURIComponent(track)}`,
        );
        if (!result) throw new Error('No tracks were found');
        return new Response(result);
      }
    }
  }

  async decodeTrack(track) {
    const node = this.leastUsedNodes[0];
    if (!node) throw new Error('No nodes are available');
    const result = await this.fetch(node, 'decodetrack', `track=${track}`);
    if (result.status === 500) return null;
    return result;
  }

  fetch(node, endpoint, param) {
    return undici.fetch(
      `http${node.secure ? 's' : ''}://${node.host}:${
        node.port
      }/${endpoint}?${param}`,
      {
        headers: {
          Authorization: node.password,
        },
      },
    )
      .then((res) => res.json())
      .catch((error) => {
        throw new Error(
          `Failed to fetch from the lavalink.\n Error: ${error}`,
        );
      });
  }

  get(guildId) {
    return this.players.get(guildId);
  }
}

module.exports = Lavamusic;
