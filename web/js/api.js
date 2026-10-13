async function req(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const r = await fetch(url, opts);
  if (r.status === 401) {
    location.href = "/login.html";
    throw new Error("Not signed in");
  }
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error(data?.error || r.statusText);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => req("GET", "/api/health"),
  projects: () => req("GET", "/api/projects"),
  createProject: (body) => req("POST", "/api/projects", body),
  project: (id) => req("GET", `/api/projects/${id}`),
  renameProject: (id, name) => req("PATCH", `/api/projects/${id}`, { name }),
  deleteProject: (id) => req("DELETE", `/api/projects/${id}`),
  upload: (id, files) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    return req("POST", `/api/projects/${id}/upload`, fd, true);
  },
  importDrive: (id, body) => req("POST", `/api/projects/${id}/import-drive`, body),
  importLocal: (id, paths) => req("POST", `/api/projects/${id}/import-local`, { paths }),
  localRoots: () => req("GET", "/api/local/roots"),
  localList: (path) => req("GET", `/api/local/list?${new URLSearchParams({ path })}`),
  settings: () => req("GET", "/api/settings"),
  saveSettings: (body) => req("PUT", "/api/settings", body),
  updateMedia: (id, mid, body) => req("PATCH", `/api/projects/${id}/media/${mid}`, body),
  deleteMedia: (id, mid, force) => req("DELETE", `/api/projects/${id}/media/${mid}${force ? "?force=1" : ""}`),
  saveTimeline: (id, timeline, revision, label) => req("PUT", `/api/projects/${id}/timeline`, { timeline, revision, label }),
  history: (id) => req("GET", `/api/projects/${id}/history`),
  restore: (id, revision) => req("POST", `/api/projects/${id}/history/restore`, { revision }),
  plan: (id, brief) => req("POST", `/api/projects/${id}/ai/plan`, { brief }),
  revise: (id, instruction) => req("POST", `/api/projects/${id}/ai/revise`, { instruction }),
  render: (id, quality) => req("POST", `/api/projects/${id}/render`, { quality }),
  deleteRender: (id, rid) => req("DELETE", `/api/projects/${id}/renders/${rid}`),
  uploadRender: (id, rid) => req("POST", `/api/projects/${id}/renders/${rid}/drive`, {}),
  jobs: (id) => req("GET", `/api/projects/${id}/jobs`),
  driveStatus: () => req("GET", "/api/drive/status"),
  driveList: (params) => req("GET", `/api/drive/list?${new URLSearchParams(params)}`),
  driveDisconnect: () => req("POST", "/api/drive/disconnect", {}),
  fileUrl: (pid, kind, file) => `/files/${pid}/${kind}/${encodeURIComponent(file)}`,
};
