const playwright = require("playwright");

function logWithTimestamp(level, ...args) {
  console[level](`[${new Date().toUTCString()}]`, ...args);
}

function contextLogWithUndefined(context, err) {
  logWithTimestamp("error", context, err);
  return undefined;
}

class Semaphore {
  constructor() {
    this._locked = false;
    this._waiters = [];
  }

  async acquire() {
    if (this._locked) {
      return new Promise(resolve => {
        this._waiters.push(resolve);
      });
    }

    this._locked = true;
    return this._release.bind(this);
  }

  _release() {
    const waiter = this._waiters.shift();

    if (waiter) {
      waiter(this._release.bind(this));
    } else {
      this._locked = false;
    }
  }
}

class SpotifyTokenHandler {
  constructor() {
    this.routes = [
      { method: "get", path: "/spotifytoken", handler: this.handler.bind(this) }
    ];

    this.semaphore = new Semaphore();
    this.cachedAccessToken = undefined;
  }

  getAccessToken() {
    return new Promise(async (resolve, reject) => {
      const browser = await playwright.chromium.launch()
        .catch(contextLogWithUndefined.bind(null, "Failed to spawn browser"));

      if (!browser) {
        return reject(new Error("Failed to launch browser"));
      }

      const page = await browser.newPage()
        .catch(contextLogWithUndefined.bind(null, "Failed to open new page"));

      if (!page) {
        browser.close();
        reject(new Error("Failed to open new page"));
      }

      let processedAccessTokenRequest = false;

      setTimeout(() => {
        if (!processedAccessTokenRequest) {
          logWithTimestamp("warn", "Deadline exceeded without processing access token request, did the endpoint change?");
        }

        browser.close();
        reject(new Error("Token fetch exceeded deadline"));
      }, 15000);

      page.addListener("requestfinished", async (event) => {
        if (!event.url().includes("/api/token")) {
          return;
        }

        processedAccessTokenRequest = true;
        const response = await event.response().catch(_ => null);

        if (!response || !response.ok()) {
          page.removeAllListeners();
          browser.close();
          return reject(new Error("Invalid response from Spotify."))
        }

        const json = await response.json().catch(_ => null);
        page.removeAllListeners();
        browser.close();

        delete json._notes;
        resolve(json);
      });

      page.goto("https://open.spotify.com/").catch(err => {
        if (!processedAccessTokenRequest) {
          browser.close();
          reject(new Error(`Failed to goto URL: ${err}`));
        }
      });
    });
  }

  /**
   * @param {import("koa").Context} ctx
   */
  async handler(ctx) {
    const isForce = ["1", "yes", "true"].includes(ctx.query["force"]?.toLowerCase());
    const start = Date.now();
    await this.handler0(ctx, isForce);
    const elapsed = Date.now() - start;
    logWithTimestamp("info", `Handled Spotify Token request for ${ctx.get("user-agent") ?? "no ua"} (force: ${isForce}) in ${elapsed}ms`);
  }

  /**
   * @param {import("koa").Context} ctx
   * @param {boolean} isForce
   */
  async handler0(ctx, isForce) {
    const self = this;

    /** @type {TokenProxy} */
    const token = {
      type: "cachedAccessToken",
      fetch: this.getAccessToken,
      get data() {
        return self[this.type];
      },
      valid() {
        return this.data?.accessTokenExpirationTimestampMs - 10000 > Date.now();
      },
      refresh() {
        return this.fetch().then(data => {
          self[this.type] = data;
          return data;
        });
      }
    };

    if (!isForce && token.valid()) {
      ctx.body = token.data;
      return;
    }

    /** @type {() => void} */
    const release = await this.semaphore.acquire();

    try {
      // double check for redundancy
      if (!isForce && token.valid()) {
        ctx.body = token.data;
      } else {
        ctx.body = await token.refresh();
      }
    } catch (e) {
      logWithTimestamp("error", e);
      ctx.status = 500;
      ctx.body = {};
    } finally {
      release();
    }
  }
}

module.exports = new SpotifyTokenHandler();

/**
 * @typedef TokenProxy
 * @property {string} type
 * @property {() => Promise<SpotifyToken>} fetch
 * @property {?SpotifyToken} data
 * @property {() => boolean} valid
 * @property {() => Promise<SpotifyToken>} refresh
 */

/**
 * @typedef SpotifyToken
 * @property {string} accessToken
 * @property {number} accessTokenExpirationTimestampMs
 */
