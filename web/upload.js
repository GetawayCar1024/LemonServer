/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const ready = new WeakSet(), pending = new WeakMap();
  const LIMIT = 1024 * 1024 * 1024;
  function readError(name, directory = false) {
    const error = new Error(directory
      ? `无法读取本地文件夹“${name}”。来源可能已失效或未授予读取权限，请使用“上传文件夹”重新选择。`
      : `无法读取本地文件“${name}”。若来自压缩软件，请先解压到本地，再重新选择或复制上传。`);
    error.code = 'FILE_READ_FAILED';
    return error;
  }
  // Capture a File while its OS/virtual-file provider still owns it. The returned File is memory-backed,
  // so later confirmation dialogs and upload queues do not depend on WinRAR's temporary path.
  function prepare(file) {
    if (!file || typeof file.name !== 'string' || ready.has(file)) return Promise.resolve(file);
    if (pending.has(file)) return pending.get(file);
    const result = (async () => {
      if (file.size > LIMIT) throw new Error(`文件“${file.name}”超过 1 GiB，请分批上传。`);
      let bytes;
      try { bytes = await file.arrayBuffer(); } catch { throw readError(file.name); }
      if (bytes.byteLength !== file.size) throw readError(file.name);
      const captured = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
      ready.add(captured);
      return captured;
    })();
    pending.set(file, result);
    result.catch(() => pending.delete(file));
    return result;
  }

  function collectFiles(transfer, { includeDirectories = false } = {}) {
    let total = 0, count = 0;
    const capture = async (file, rel) => {
      if (++count > 50000) throw new Error('文件数量过多，请分批上传。');
      total += file.size;
      if (total > LIMIT) throw new Error('一次上传的内容超过 1 GiB，请分批选择。');
      return [{ file: await prepare(file), rel }];
    };
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => {
          try { entry.file(resolve, () => reject(readError(entry.name))); } catch { reject(readError(entry.name)); }
        });
        return capture(file, prefix + file.name);
      }
      if (!entry.isDirectory) throw readError(entry.name || '拖入内容');
      if (++count > 50000 || prefix.split('/').length > 100) throw new Error('文件夹层次或数量过多，请分批上传。');
      let reader;
      try { reader = entry.createReader(); } catch { throw readError(entry.name, true); }
      const entries = [];
      for (;;) {
        const batch = await new Promise((resolve, reject) => {
          try { reader.readEntries(resolve, () => reject(readError(entry.name, true))); } catch { reject(readError(entry.name, true)); }
        });
        if (!batch.length) break;
        entries.push(...batch);
        if (entries.length > 50000) throw new Error('文件夹内容过多，请分批上传。');
      }
      const rel = prefix + entry.name;
      const children = await Promise.all(entries.map(child => walk(child, rel + '/')));
      return [...(includeDirectories ? [{ directory: true, rel }] : []), ...children.flat()];
    };
    const tasks = [];
    for (const item of transfer.items || []) {
      if (item.kind && item.kind !== 'file') continue;
      let entry, file;
      try { entry = item.webkitGetAsEntry?.(); file = entry?.isDirectory ? null : item.getAsFile?.(); }
      catch { tasks.push(Promise.reject(readError('拖入内容'))); continue; }
      if (file) tasks.push(capture(file, file.name));
      else if (entry) tasks.push(walk(entry, ''));
      else if (item.kind === 'file') tasks.push(Promise.reject(readError('拖入内容')));
    }
    if (!tasks.length) for (const file of transfer.files || []) tasks.push(capture(file, file.webkitRelativePath || file.name));
    return Promise.all(tasks).then(items => items.flat());
  }
  // Fetch does not expose upload byte progress. Return a Response so normal API error handling is reused.
  function request(url, { method = 'PUT', headers = {}, body, onProgress = () => {} }) {
    if (body && typeof body.name === 'string' && !ready.has(body))
      return prepare(body).then(captured => request(url, { method, headers, body: captured, onProgress }));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.responseType = 'arraybuffer';
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      const total = body.size;
      const progress = loaded => onProgress(Math.min(total, Math.max(0, loaded)), total);
      xhr.upload.onprogress = event => progress(event.loaded);
      xhr.upload.onload = () => progress(total);
      xhr.onerror = () => {
        const error = new Error('上传失败：未收到服务器确认，可能是连接中断或服务器提前拒绝。请重试，并检查服务器日志和上传大小限制。');
        error.code = 'UPLOAD_CONNECTION_FAILED'; reject(error);
      };
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.onload = () => {
        if (!xhr.status) { xhr.onerror(); return; }
        try {
          const responseHeaders = new Headers();
          for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
            const colon = line.indexOf(':');
            if (colon > 0) responseHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
          }
          progress(total);
          resolve(new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response, { status: xhr.status, statusText: xhr.statusText, headers: responseHeaders }));
        } catch (error) { reject(error); }
      };
      xhr.send(body);
    });
  }
  const api = { request, prepare, collectFiles };
  root.LemonUpload = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
