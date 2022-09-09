const { EventEmitter } = require('node:events');
const Queue = require('./guild/Queue');
const Filters = require('./guild/Filter');

class Player extends EventEmitter {
  constructor(manager, node, options) {
    super();
    this.manager = manager;
    this.queue = new Queue();
    this.node = node;
    this.options = options;
    this.filters = new Filters(this, this.node);
    this.guildId = options.guildId;
    this.voiceChannelId = options.voiceChannelId;
    this.textChannelId = options.textChannelId;
    this.connected = false;
    this.playing = false;
    this.paused = false;
    this.loop = 'disabled';
    this.position = 0;
    this.volume = 100;
    this.currentTrack = null;
    this.previousTrack = null;
    this.voiceUpdateState = null;

    this.on('event', (data) => this.lavalinkEvent(data).bind(this)());
    this.on('playerUpdate', (packet) => {
      (this.connected = packet.state.connected),
        (this.position = packet.state.position);
      this.manager.emit('playerUpdate', this, packet);
    });

       this.manager.emit(
      'debug',
      `Created a player in ${this.guildId}`,
    );
 
    this.manager.emit('playerCreate', this);
  }

   skip(amount) {
     if (typeof amount === 'number' && amount > 1) {
       if (amount > this.queue.length) throw new Error('Cannot skip more than the queue length.');
       this.queue.splice(0, amount - 1);
     }

     this.node.send({
      op: 'stop',
      guildId: this.guild,
     });

     return this;
  }
  
  async play(options = {}) {
    if (!this.queue.length) {
      return null;
    }

    this.currentTrack = this.queue.shift();

    if (!this.currentTrack.track) {
      this.currentTrack = await this.currentTrack.resolve(this.manager);
    }

    this.playing = true;
    this.node.send({
      op: 'play',
      guildId: this.guildId,
      track: this.currentTrack.track,
      noReplace: options.noReplace || true,
    });
    this.position = 0;

    this.manager.emit(
      'debug',
      `Started playing ${this.currentTrack.info.title} in ${this.guildId}`,
    );

    return this;
  }

  pause(value = true) {
    if (typeof value !== 'boolean') {
      throw new RangeError('Expected a boolean value for this function');
    }

    this.node.send({
      op: 'pause',
      guildId: this.guildId,
      value,
    });
    this.playing = !value;
    this.paused = value;

    return this;
  }

  seekTo(position) {
    if (Number.isNaN(position)) {
      throw new RangeError('Position must be a number');
    }
    this.position = position;
    this.node.send({
      op: 'seek',
      guildId: this.guildId,
      position,
    });
    return this;
  }

  setVolume(volume) {
    if (Number.isNaN(volume)) {
      throw new RangeError('Volume must be a number.');
    }

    this.volume = volume;
    this.node.send({
      op: 'volume',
      guildId: this.guildId,
      volume: this.volume,
    });
    return this;
  }

  setLoopMode(mode) {
    if (!mode) {
      throw new Error(
        'Loop mode must be provided as a parameter for this method',
      );
    }

    if (!['disabled', 'track', 'queue'].includes(mode)) {
      throw new Error(
        'Loop mode must be one of "disabled", "track" or "queue".',
      );
    }

    switch (mode) {
      case 'disabled': {
        this.loop = 'disabled';
        break;
      }
      case 'track': {
        this.loop = 'track';
        break;
      }
      case 'queue': {
        this.loop = 'queue';
        break;
      }
    }

    return this;
  }

  setTextChannel(channelId) {
    if (typeof channelId !== 'string') {
      throw new RangeError('Channel Id must be a string.');
    }
    this.textChannelId = channelId;
    return this;
  }

  setVoiceChannel(channelId) {
    if (typeof channelId !== 'string') {
      throw new RangeError('Channel Id must be a string.');
    }

    this.voiceChannelId = channelId;
    return this;
  }

  connect(options = this) {
    const { guildId, voiceChannelId, selfDeaf, selfMute } = options;
    this.send(
      {
        guild_id: guildId,
        channel_id: voiceChannelId,
        self_deaf: selfDeaf || true,
        self_mute: selfMute || false,
      },
      true,
    );

    this.connected = true;
    this.manager.emit(
      'debug',
      `Player has been connected in ${this.guildId}`,
    );
  }

  updateSession(data) {
    if (data) {
      this.voiceUpdateState = data;
      this.node.send({
        op: 'voiceUpdate',
        guildId: this.guildId,
        ...data,
      });
    }
    return this;
  }

  reconnect() {
    if (this.voiceChannelId === null) return null;
    this.send({
      guild_id: this.guildId,
      channel_id: this.voiceChannelId,
      self_mute: false,
      self_deaf: false,
    });

    return this;
  }

  disconnect() {
    if (this.voiceChannelId === null) return null;
    this.pause(true);
    this.connected = false;
    this.send({
      guild_id: this.guildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
    this.voiceChannelId = null;
    return this;
  }

  destroy() {
    this.disconnect();
    this.node.send({
      op: 'destroy',
      guildId: this.guildId,
    });

    this.manager.emit('playerDestroy', this);
    this.manager.emit('debug', `Destroyed the player in ${this.guildId}`);

    this.manager.players.delete(this.guildId);
  }

  replay() {
    this.filters.updateFilters();
    if (this.currentTrack) {
      this.playing = true;
      this.node.send({
        op: '',
        startTime: this.position,
        noReplace: true,
        guildId: this.guildId,
        track: this.currentTrack.track,
        pause: this.paused,
      });
    }
  }

  async toggleAutoplay(value = false) {
    if (!value) return;
    try {
      const data = `https://www.youtube.com/watch?v=${
        this.previousTrack.info.identifier || this.currentTrack.info.identifier
      }&list=RD${
        this.previousTrack.info.identifier || this.currentTrack.info.identifier
      }`;

      const response = await this.manager.resolve(
        data,
        this.manager.options.defaultPlatform || 'ytsearch',
      );

      if (
        !response ||
        !response.tracks ||
        ['LOAD_FAILED', 'NO_MATCHES'].includes(response.loadType)
      ) {
        return this.stop();
      }

      const track =
        response.tracks[
          Math.floor(Math.random() * Math.floor(response.tracks.length))
        ];

      this.queue.push(track);
      this.play();

      return this;
    } catch (error) {
      console.log(`Autoplay error : ${error}`);
      return this.stop();
    }
  }

  send(data) {
    this.manager.sendData({ op: 4, d: data });
  }

  lavalinkEvent(data) {
    const events = {
      TrackStartEvent() {
        this.playing = true;
        this.paused = false;
        this.manager.emit('trackStart', this, this.currentTrack, data);
      },
      TrackEndEvent() {
        this.previousTrack = this.currentTrack;

        if (this.currentTrack && this.loop === 'track') {
          this.queue.unshift(this.previousTrack);
          this.manager.emit('trackEnd', this, this.currentTrack, data);
          
          return this.play();
        } else if (this.currentTrack && this.loop === 'queue') {
          this.queue.push(this.previousTrack);
          this.manager.emit('trackEnd', this, this.currentTrack, data);

          return this.play();
        }

        if (this.queue.length === 0) {
          return this.manager.emit('queueEnd', this, this.track, data);
        } else if (this.queue.length > 0) {
          this.manager.emit('trackEnd', this, this.currentTrack, data);
          return this.play();
        }
        this.manager.emit('queueEnd', this, this.currentTrack, data);
      },
      TrackStuckEvent() {
        this.manager.emit('trackStuck', this, this.currentTrack, data);
        this.stop();
      },
      TrackExceptionEvent() {
        this.manager.emit('trackError', this, this.track, data);
        this.stop();
      },
      WebSocketClosedEvent() {
        if ([4015, 4009].includes(data.code)) {
          this.send({
            guild_id: data.guildId,
            channel_id: this.voiceChannelId,
            self_mute: this.options.mute || false,
            self_deaf: this.options.deaf || false,
          });
        }
        this.manager.emit('socketClosed', this, data);
      },
      default() {
        throw new Error(`An unknown event: ${data}`);
      },
    };
    return events[data.type] || events.default;
  }
}

module.exports = Player;
