import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';
import { FileList } from '../components/file-list.mjs';
import { Breadcrumb } from '../components/breadcrumb.mjs';

async function loadDirectory(currentPath, items, loading, selectedFile, fileContent, path) {
  loading.value = true;
  selectedFile.value = null;
  fileContent.value = '';
  try {
    const data = await api.get(`/files/browse?path=${encodeURIComponent(path || '')}`);
    currentPath.value = data.path || '';
    items.value = data.items;
  } catch (e) {
    addToast(`Failed to load directory: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

function makeNavigateToDir(currentPath, items, loading, selectedFile, fileContent) {
  return function navigateToDir(dirName) {
    const newPath = currentPath.value ? `${currentPath.value}/${dirName}` : dirName;
    loadDirectory(currentPath, items, loading, selectedFile, fileContent, newPath);
  };
}

function makeNavigateToPath(currentPath, items, loading, selectedFile, fileContent) {
  return function navigateToPath(path) {
    loadDirectory(currentPath, items, loading, selectedFile, fileContent, path);
  };
}

function makeGoUp(currentPath, items, loading, selectedFile, fileContent) {
  return function goUp() {
    if (!currentPath.value) return;
    const parts = currentPath.value.split('/');
    parts.pop();
    loadDirectory(currentPath, items, loading, selectedFile, fileContent, parts.join('/'));
  };
}

function makeSelectFile(currentPath, selectedFile, fileContent, fileLoading) {
  return async function selectFile(item) {
    if (!item.isText) {
      addToast('Binary files cannot be previewed', 'warning');
      return;
    }

    selectedFile.value = item;
    fileLoading.value = true;
    try {
      const filePath = currentPath.value ? `${currentPath.value}/${item.name}` : item.name;
      const data = await api.get(`/files/read?path=${encodeURIComponent(filePath)}`);
      fileContent.value = data.content;
    } catch (e) {
      addToast(`Failed to read file: ${e.message}`, 'error');
      fileContent.value = '';
    } finally {
      fileLoading.value = false;
    }
  };
}

function makeClosePreview(selectedFile, fileContent) {
  return function closePreview() {
    selectedFile.value = null;
    fileContent.value = '';
  };
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function makeUploadFile(currentPath, items, loading, selectedFile, fileContent, uploadBusy) {
  return async function uploadFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || uploadBusy.value) return;

    uploadBusy.value = true;
    try {
      const contentBase64 = bytesToBase64(await file.arrayBuffer());
      await api.post('/files/upload', {
        path: currentPath.value,
        filename: file.name,
        contentBase64,
      });
      addToast(`Uploaded ${file.name}`, 'success');
      await loadDirectory(currentPath, items, loading, selectedFile, fileContent, currentPath.value);
    } catch (e) {
      addToast(`Failed to upload file: ${e.message}`, 'error');
    } finally {
      uploadBusy.value = false;
    }
  };
}

function makeCreateDocument(currentPath, items, loading, selectedFile, fileContent, documentForm) {
  return async function createDocument() {
    const form = documentForm.value;
    const name = String(form.name || '').trim();
    if (!name || form.busy) return;

    documentForm.value = { ...form, busy: true };
    try {
      const created = await api.post('/files/document', {
        path: currentPath.value,
        name,
        content: form.content || '',
      });
      addToast(`Created ${created.name}`, 'success');
      documentForm.value = { open: false, name: '', content: '', busy: false };
      await loadDirectory(currentPath, items, loading, selectedFile, fileContent, currentPath.value);
    } catch (e) {
      addToast(`Failed to create document: ${e.message}`, 'error');
      documentForm.value = { ...documentForm.value, busy: false };
    }
  };
}

export function FilesPage() {
  const currentPath = useMemo(() => signal(''), []);
  const items = useMemo(() => signal([]), []);
  const loading = useMemo(() => signal(false), []);
  const selectedFile = useMemo(() => signal(null), []);
  const fileContent = useMemo(() => signal(''), []);
  const fileLoading = useMemo(() => signal(false), []);
  const uploadBusy = useMemo(() => signal(false), []);
  const documentForm = useMemo(() => signal({ open: false, name: '', content: '', busy: false }), []);

  const navigateToDir = useMemo(() => makeNavigateToDir(currentPath, items, loading, selectedFile, fileContent), []);
  const navigateToPath = useMemo(() => makeNavigateToPath(currentPath, items, loading, selectedFile, fileContent), []);
  const goUp = useMemo(() => makeGoUp(currentPath, items, loading, selectedFile, fileContent), []);
  const selectFile = useMemo(() => makeSelectFile(currentPath, selectedFile, fileContent, fileLoading), []);
  const closePreview = useMemo(() => makeClosePreview(selectedFile, fileContent), []);
  const uploadFile = useMemo(() => makeUploadFile(currentPath, items, loading, selectedFile, fileContent, uploadBusy), []);
  const createDocument = useMemo(() => makeCreateDocument(currentPath, items, loading, selectedFile, fileContent, documentForm), []);

  useEffect(() => { loadDirectory(currentPath, items, loading, selectedFile, fileContent, ''); }, []);

  return html`
    <div class="page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">File Browser</h1>
        <div style="display:flex; gap:8px">
          <input id="files-upload-input" type="file" style="display:none" onChange=${uploadFile} />
          <button class="btn" disabled=${uploadBusy.value} onclick=${() => document.getElementById('files-upload-input')?.click()}>
            ${uploadBusy.value ? 'Uploading...' : 'Upload file'}
          </button>
          <button class="btn btn-primary" onclick=${() => { documentForm.value = { ...documentForm.value, open: true }; }}>New document</button>
          ${currentPath.value ? html`<button class="btn" onclick=${goUp}>↑ Up</button>` : null}
          <button class="btn" onclick=${() => loadDirectory(currentPath, items, loading, selectedFile, fileContent, currentPath.value)}>Refresh</button>
        </div>
      </div>

      <div class="card" style="padding:10px 16px">
        <${Breadcrumb} path=${currentPath.value} onNavigate=${navigateToPath} />
      </div>

      ${documentForm.value.open ? html`
        <div class="card">
          <div class="card-header">
            <span class="card-title">Upload document</span>
            <button class="btn" disabled=${documentForm.value.busy} onclick=${() => { documentForm.value = { open: false, name: '', content: '', busy: false }; }}>Close</button>
          </div>
          <div style="display:grid; gap:10px">
            <label style="display:grid; gap:4px; font-size:12px; color:var(--text-muted)">
              Filename
              <input
                class="input"
                placeholder="notes.md"
                value=${documentForm.value.name}
                disabled=${documentForm.value.busy}
                onInput=${e => { documentForm.value = { ...documentForm.value, name: e.currentTarget.value }; }}
              />
            </label>
            <label style="display:grid; gap:4px; font-size:12px; color:var(--text-muted)">
              Content
              <textarea
                class="input"
                rows="8"
                placeholder="# New document"
                disabled=${documentForm.value.busy}
                onInput=${e => { documentForm.value = { ...documentForm.value, content: e.currentTarget.value }; }}
              >${documentForm.value.content}</textarea>
            </label>
            <div style="display:flex; justify-content:flex-end; gap:8px">
              <button class="btn" disabled=${documentForm.value.busy} onclick=${() => { documentForm.value = { open: false, name: '', content: '', busy: false }; }}>Cancel</button>
              <button class="btn btn-primary" disabled=${documentForm.value.busy || !documentForm.value.name.trim()} onclick=${createDocument}>
                ${documentForm.value.busy ? 'Creating...' : 'Create document'}
              </button>
            </div>
          </div>
        </div>
      ` : null}

      ${selectedFile.value ? html`
        <div class="card">
          <div class="card-header">
            <span class="card-title">${selectedFile.value.name}</span>
            <div style="display:flex; align-items:center; gap:12px">
              <span style="font-size:11px; color:var(--text-muted)">${selectedFile.value.sizeFormatted}</span>
              <button class="btn" onclick=${closePreview}>Close</button>
            </div>
          </div>
          ${fileLoading.value
            ? html`<p style="color:var(--text-muted)">Loading file...</p>`
            : html`
              <div class="terminal" style="max-height:500px; overflow:auto">
                <pre style="margin:0; white-space:pre-wrap; word-break:break-all">${fileContent.value}</pre>
              </div>
            `
          }
        </div>
      ` : null}

      <div class="card" style="padding:0; overflow:hidden">
        ${loading.value
          ? html`<p style="padding:16px; color:var(--text-muted)">Loading...</p>`
          : html`<${FileList} items=${items.value} onNavigate=${navigateToDir} onSelectFile=${selectFile} />`
        }
      </div>
    </div>
  `;
}
