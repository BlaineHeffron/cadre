import { existsSync, readdirSync, readFileSync, statSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize, extname, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_ROOT = join(homedir(), 'projects');
const MAX_FILE_SIZE = 1024 * 1024; // 1MB max for file reading
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024; // 8MB max; base64 JSON stays below server bodyLimit
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.fish',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.html', '.css', '.scss', '.less', '.xml', '.svg',
  '.env', '.env.example', '.gitignore', '.dockerignore',
  '.sql', '.graphql', '.proto', '.lock',
  '', // extensionless files like Makefile, Dockerfile
]);

function getAllowedRoot() {
  return process.env.FILE_BROWSER_ROOT || DEFAULT_ROOT;
}

function safePath(requested) {
  const root = realpathSync(getAllowedRoot());

  // Block any requested path containing '..' to prevent traversal attempts
  if (requested && (requested.includes('..') || requested.includes('%2e%2e'))) {
    throw new Error('Path outside allowed directory');
  }

  const resolved = resolve(root, requested || '');
  const normalized = normalize(resolved);

  // Resolve symlinks to get the real absolute path
  let realPath;
  try {
    realPath = realpathSync(normalized);
  } catch (err) {
    // If path doesn't exist yet, check parent directories
    if (err.code === 'ENOENT') {
      try {
        if (lstatSync(normalized).isSymbolicLink()) {
          throw new Error('Symlinks are not allowed');
        }
      } catch (inner) {
        if (inner.message === 'Symlinks are not allowed') throw inner;
        if (inner.code !== 'ENOENT') throw inner;
      }
      const parent = dirname(normalized);
      const parentReal = realpathSync(parent);
      if (!parentReal.startsWith(root + '/') && parentReal !== root) {
        throw new Error('Path outside allowed directory');
      }
      if (!normalized.startsWith(root + '/') && normalized !== root) {
        throw new Error('Path outside allowed directory');
      }
      return normalized;
    }
    throw err;
  }

  // Verify the real path is within the real root
  if (!realPath.startsWith(root + '/') && realPath !== root) {
    throw new Error('Path outside allowed directory');
  }

  return realPath;
}

function isTextFile(filename) {
  const ext = extname(filename).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeFilename(name) {
  const filename = String(name || '').trim();
  if (!filename) {
    throw new Error('Filename is required');
  }
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new Error('Filename cannot include path separators');
  }
  if (filename === '.' || filename === '..' || filename.includes('..')) {
    throw new Error('Invalid filename');
  }
  return filename;
}

function ensureWritableTarget(dirPath, filename, overwrite = false) {
  const dir = safePath(dirPath || '');
  const dirLstat = lstatSync(dir);
  if (dirLstat.isSymbolicLink()) {
    throw new Error('Symlinks are not allowed');
  }
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error('Upload path must be a directory');
  }

  const target = safePath(join(dirPath || '', filename));
  let targetLstat;
  try {
    targetLstat = lstatSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (targetLstat?.isSymbolicLink()) {
    throw new Error('Symlinks are not allowed');
  }
  if (targetLstat && !overwrite) {
    const err = new Error('File already exists');
    err.code = 'EEXIST';
    throw err;
  }
  return target;
}

function infoForFile(filePath, requestedPath) {
  const stat = statSync(filePath);
  return {
    path: requestedPath,
    name: basename(filePath),
    type: 'file',
    size: stat.size,
    sizeFormatted: formatSize(stat.size),
    modified: stat.mtime.toISOString(),
    isText: isTextFile(basename(filePath)),
    extension: extname(filePath).toLowerCase(),
  };
}

export async function filesPlugin(app) {
  // Browse directories — list all entries with metadata
  app.get('/api/files/browse', async (req, reply) => {
    try {
      const root = realpathSync(getAllowedRoot());
      const dir = safePath(req.query.path || '');

      // Verify dir is not a symlink (prevent TOCTOU race)
      const lstat = lstatSync(dir);
      if (lstat.isSymbolicLink()) {
        return reply.code(400).send({ error: 'Symlinks are not allowed' });
      }

      const entries = readdirSync(dir, { withFileTypes: true });

      const items = [];
      for (const entry of entries) {
        // Skip hidden files and directories, except .env.example
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        if (entry.name === 'node_modules') continue;

        const fullPath = join(dir, entry.name);
        try {
          // Use lstat to detect symlinks, reject them
          const lstat = lstatSync(fullPath);
          if (lstat.isSymbolicLink()) {
            continue; // Skip symlinks entirely
          }
          const stat = statSync(fullPath);

          if (entry.isDirectory()) {
            items.push({
              name: entry.name,
              type: 'dir',
              size: null,
              modified: stat.mtime.toISOString(),
            });
          } else if (entry.isFile()) {
            items.push({
              name: entry.name,
              type: 'file',
              size: stat.size,
              sizeFormatted: formatSize(stat.size),
              modified: stat.mtime.toISOString(),
              isText: isTextFile(entry.name),
              extension: extname(entry.name).toLowerCase(),
            });
          }
        } catch (error) {
          app.log.warn({ path: fullPath, error }, 'Failed to stat entry');
          // Skip entries we can't stat (permission errors, etc.)
        }
      }

      // Sort: dirs first, then files, alphabetical within each
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const relativePath = dir.replace(root, '').replace(/^\//, '') || '';

      return {
        path: relativePath,
        root,
        parent: relativePath ? dirname(relativePath) : null,
        items,
      };
    } catch (err) {
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'Directory not found' });
      if (err.code === 'ENOTDIR') return reply.code(400).send({ error: 'Not a directory' });
      return reply.code(400).send({ error: err.message });
    }
  });

  // Read file content
  app.get('/api/files/read', async (req, reply) => {
    try {
      const filePath = safePath(req.query.path || '');

      // Verify not a symlink (prevent TOCTOU race)
      const lstat = lstatSync(filePath);
      if (lstat.isSymbolicLink()) {
        return reply.code(400).send({ error: 'Symlinks are not allowed' });
      }

      const stat = statSync(filePath);

      if (stat.isDirectory()) {
        return reply.code(400).send({ error: 'Path is a directory, not a file' });
      }

      if (stat.size > MAX_FILE_SIZE) {
        return reply.code(413).send({ error: `File too large: ${formatSize(stat.size)} (max ${formatSize(MAX_FILE_SIZE)})` });
      }

      if (!isTextFile(basename(filePath))) {
        return reply.code(415).send({ error: 'Binary files cannot be displayed' });
      }

      const content = readFileSync(filePath, 'utf-8');
      return {
        path: req.query.path,
        name: basename(filePath),
        extension: extname(filePath).toLowerCase(),
        size: stat.size,
        modified: stat.mtime.toISOString(),
        content,
      };
    } catch (err) {
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'File not found' });
      return reply.code(400).send({ error: err.message });
    }
  });

  // Get file or directory info (metadata only)
  app.get('/api/files/info', async (req, reply) => {
    try {
      const targetPath = safePath(req.query.path || '');

      // Verify not a symlink (prevent TOCTOU race)
      const lstat = lstatSync(targetPath);
      if (lstat.isSymbolicLink()) {
        return reply.code(400).send({ error: 'Symlinks are not allowed' });
      }

      const stat = statSync(targetPath);

      return {
        path: req.query.path || '',
        name: basename(targetPath),
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        sizeFormatted: formatSize(stat.size),
        modified: stat.mtime.toISOString(),
        isText: stat.isFile() ? isTextFile(basename(targetPath)) : null,
        extension: stat.isFile() ? extname(targetPath).toLowerCase() : null,
      };
    } catch (err) {
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'Path not found' });
      return reply.code(400).send({ error: err.message });
    }
  });

  // Upload a file into the selected directory.
  app.post('/api/files/upload', async (req, reply) => {
    try {
      const body = req.body || {};
      const dirPath = String(body.path || '');
      const filename = sanitizeFilename(body.filename);
      const contentBase64 = String(body.contentBase64 || '');
      const overwrite = Boolean(body.overwrite);
      const target = ensureWritableTarget(dirPath, filename, overwrite);

      let buffer;
      try {
        buffer = Buffer.from(contentBase64, 'base64');
      } catch {
        return reply.code(400).send({ error: 'Invalid base64 content' });
      }

      if (buffer.length > MAX_UPLOAD_SIZE) {
        return reply.code(413).send({ error: `Upload too large: ${formatSize(buffer.length)} (max ${formatSize(MAX_UPLOAD_SIZE)})` });
      }

      writeFileSync(target, buffer, { flag: overwrite ? 'w' : 'wx' });
      const relativePath = dirPath ? `${dirPath}/${filename}` : filename;
      return reply.code(201).send(infoForFile(target, relativePath));
    } catch (err) {
      if (err.code === 'EEXIST') return reply.code(409).send({ error: 'File already exists' });
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'Directory not found' });
      if (err.code === 'ENOTDIR') return reply.code(400).send({ error: 'Not a directory' });
      return reply.code(400).send({ error: err.message });
    }
  });

  // Create a text document in the selected directory.
  app.post('/api/files/document', async (req, reply) => {
    try {
      const body = req.body || {};
      const dirPath = String(body.path || '');
      const rawName = sanitizeFilename(body.name);
      const filename = extname(rawName) ? rawName : `${rawName}.md`;
      const content = String(body.content || '');
      const overwrite = Boolean(body.overwrite);
      const target = ensureWritableTarget(dirPath, filename, overwrite);
      const bytes = Buffer.byteLength(content, 'utf8');

      if (bytes > MAX_UPLOAD_SIZE) {
        return reply.code(413).send({ error: `Document too large: ${formatSize(bytes)} (max ${formatSize(MAX_UPLOAD_SIZE)})` });
      }

      writeFileSync(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
      const relativePath = dirPath ? `${dirPath}/${filename}` : filename;
      return reply.code(201).send(infoForFile(target, relativePath));
    } catch (err) {
      if (err.code === 'EEXIST') return reply.code(409).send({ error: 'File already exists' });
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'Directory not found' });
      if (err.code === 'ENOTDIR') return reply.code(400).send({ error: 'Not a directory' });
      return reply.code(400).send({ error: err.message });
    }
  });
}
