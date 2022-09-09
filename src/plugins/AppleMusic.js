const { fetch } = require('undici');
const Track = require('../guild/Track');

/* eslint-disable no-useless-escape */
const regex =
  /(?:https:\/\/music\.apple\.com\/)(?:.+)?(artist|album|music-video|playlist)\/([\w\-\.]+(\/)+[\w\-\.]+|[^&]+)\/([\w\-\.]+(\/)+[\w\-\.]+|[^&]+)/;

class AppleMusic {
  constructor(manager, options) {
    this.manager = manager;
    this.options = {
      playlistLimit: options.playlistLimit || null,
      albumLimit: options.albumLimit || null,
      artistLimit: options.artistLimit || null,
      searchMarket: options.searchMarket || 'us',
      imageHeight: options.imageHeight || 500,
      imageWeight: options.imageWeight || 500,
    };
    this.url = `https://amp-api.music.apple.com/v1/catalog/${this.options.searchMarket}`;
    this.token = null;
  }

  check(url) {
    return regex.test(url);
  }

  async requestToken() {
    try {
      const req = await fetch('https://music.apple.com/us/browse');
      const json = await req.text();
      let config =
        /<meta name="desktop-music-app\/config\/environment" content="(.*?)">/.exec(
          json,
        );

      const key = (config = JSON.parse(decodeURIComponent(config[1])));
      const { token } = key?.MEDIA_API;

      if (!token) throw new Error('No access key found for apple music');

      this.token = `Bearer ${token}`;
    } catch (error) {
      if (error.status === 400) {
        throw new Error(`Apple Music : ${error}`);
      }
    }
  }

  async requestData(param) {
    if (!this.token) await this.requestToken();

    const req = await fetch(`${this.url}${param}`, {
      headers: {
        Authorization: `${this.token}`,
        origin: 'https://music.apple.com',
      },
    });
    const body = await req.json();

    return body;
  }

  async resolve(url) {
    const [, type] = regex.exec(url);

    switch (type) {
      case 'playlist': {
        return this.fetchPlaylist(url);
      }
      case 'album': {
        return this.fetchAlbum(url);
      }
      case 'artist': {
        return this.fetchArtist(url);
      }
    }
  }

  async fetch(query) {
    if (this.check(query)) return this.resolve(query);

    try {
      const tracks = await this.requestData(
        `/search?types=songs&term=${query}`,
      );

      const track = await this.buildUnresolved(tracks.results.songs.data[0]);

      return this.buildResponse('TRACK_LOADED', [track]);
    } catch (error) {
      return this.buildResponse(
        'LOAD_FAILED',
        [],
        undefined,
        error.body?.error.message ?? error.message,
      );
    }
  }

  async fetchPlaylist(url) {
    try {
      const query = new URL(url).pathname.split('/');
      const id = query.pop();
      const playlist = await this.requestData(`/playlists/${id}`);
      const name = playlist.data[0].attributes.name;

      const limitedTracks = this.options.playlistLimit
        ? playlist.data[0].relationships.tracks.data.slice(
            0,
            this.options.playlistLimit * 100,
          )
        : playlist.data[0].relationships.tracks.data;

      const tracks = await Promise.all(
        limitedTracks.map((track) => this.buildUnresolved(track)),
      );
      return this.buildResponse('PLAYLIST_LOADED', tracks, name);
    } catch (error) {
      return this.buildResponse(
        'LOAD_FAILED',
        [],
        undefined,
        error.body?.error.message ?? error.message,
      );
    }
  }

  async fetchAlbum(url) {
    try {
      const query = new URL(url).pathname.split('/');
      const id = query.pop();
      const album = await this.requestData(`/albums/${id}`);

      const limitedTracks = this.options.albumLimit
        ? album.data[0].relationships.tracks.data.slice(
            0,
            this.options.albumLimit * 100,
          )
        : album.data[0].relationships.tracks.data;

      const name = album.data[0].attributes.name;
      const tracks = await Promise.all(
        limitedTracks.map((track) => this.buildUnresolved(track)),
      );
      return this.buildResponse('PLAYLIST_LOADED', tracks, name);
    } catch (error) {
      return this.buildResponse(
        'LOAD_FAILED',
        [],
        undefined,
        error.body?.error.message ?? error.message,
      );
    }
  }

  async fetchArtist(url) {
    try {
      const query = new URL(url).pathname.split('/');
      const id = query.pop();
      const artist = await this.requestData(`/attists/${id}`);
      const name = artist.data[0].attributes.name;

      const limitedTracks = this.options.artistLimit
        ? artist.data[0].relationships.tracks.data.slice(
            0,
            this.options.artist * 100,
          )
        : artist.data[0].relationships.tracks.data;

      const tracks = await Promise.all(
        limitedTracks.map((track) => this.buildUnresolved(track)),
      );
      return this.buildResponse('PLAYLIST_LOADED', tracks, name);
    } catch (error) {
      return this.buildResponse(
        'LOAD_FAILED',
        [],
        undefined,
        error.body?.error.message ?? error.message,
      );
    }
  }

  async buildUnresolved(track) {
    if (!track) {
      throw new ReferenceError('The Apple track object was not provided');
    }

    return new Track({
      track: '',
      info: {
        sourceName: 'Apple Music',
        identifier: track.id,
        isSeekable: true,
        author: track.attributes.artistName
          ? track.attributes.artistName
          : 'Unknown',
        length: track.attributes.durationInMillis,
        isStream: false,
        title: track.attributes.name,
        uri: track.attributes.url,
        image: track.attributes.artwork.url
          .replace('{w}', this.options.imageWeight)
          .replace('{h}', this.options.imageHeight),
      },
    });
  }

  compareValue(value) {
    return typeof value !== 'undefined'
      ? value !== null
      : typeof value !== 'undefined';
  }

  buildResponse(loadType, tracks, playlistName, exceptionMsg) {
    return Object.assign(
      {
        loadType,
        tracks,
        playlistInfo: playlistName ? { name: playlistName } : {},
      },
      exceptionMsg
        ? { exception: { message: exceptionMsg, severity: 'COMMON' } }
        : {},
    );
  }
}
module.exports = AppleMusic;
