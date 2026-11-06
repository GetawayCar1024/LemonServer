/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  // Fetch does not expose upload byte progress. Return a Response so normal API error handling is reused.
  function request(url, { method = 'PUT', headers = {}, body, onProgress = () => {} }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.responseType = 'arraybuffer';
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      const total = body.size;
      const progress = loaded => onProgress(Math.min(total, Math.max(0, loaded)), total);
      xhr.upload.onprogress = event => progress(event.loaded);
      xhr.upload.onload = () => progress(total);
      xhr.onerror = () => reject(new Error('网络错误，上传失败'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.onload = () => {
        if (!xhr.status) { reject(new Error('上传连接中断')); return; }
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
  const api = { request };
  root.LemonUpload = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
