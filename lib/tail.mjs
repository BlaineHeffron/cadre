import { open, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';

export class FileTailer extends EventEmitter {
  /**
   * @param {string} filePath — path to file to tail
   * @param {object} [opts] — { fromEnd: true }
   */
  constructor(filePath, opts = {}) {
    super();
    this.filePath = filePath;
    this.position = 0;
    this.fromEnd = opts.fromEnd ?? true;
    this.watcher = null;
    this.buffer = '';
    this.running = false;
    this.reading = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;

    try {
      const s = await stat(this.filePath);
      this.position = this.fromEnd ? s.size : 0;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }

    this.watcher = watch(this.filePath, () => {
      void this._readNewContent();
    });

    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });
  }

  async _readNewContent() {
    if (this.reading) return;
    this.reading = true;

    try {
      const fh = await open(this.filePath, 'r');
      const s = await fh.stat();

      if (s.size < this.position) {
        // File was truncated/rotated
        this.position = 0;
      }

      if (s.size > this.position) {
        const buf = Buffer.alloc(s.size - this.position);
        await fh.read(buf, 0, buf.length, this.position);
        this.position = s.size;

        this.buffer += buf.toString('utf-8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (line.trim()) {
            this.emit('line', line);
          }
        }
      }

      await fh.close();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.reading = false;
    }
  }

  stop() {
    this.running = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
