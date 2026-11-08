// Közös Kód Editor: szobánkénti memóriabeli projektfa + valós idejű szinkron
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB / fájl
const MAX_NAME_LENGTH = 100;

function getDefaultProjectTree() {
  return {
    id: 'root',
    name: 'Projekt',
    type: 'folder',
    children: [
      {
        id: 'file-index-js',
        name: 'index.js',
        type: 'file',
        content: `// ======================================\n// 💻 Közös Discord Kód Editor\n// Bárki szerkesztheti valós időben!\n// ======================================\n\nfunction koszontes(nev) {\n  console.log(\`Üdvözlünk a szobában, \${nev}! 🎉\`);\n  return true;\n}\n\nconst szoba = "Általános Hang";\nkoszontes("Csapattárs");\n`
      },
      {
        id: 'folder-src',
        name: 'src',
        type: 'folder',
        children: [
          {
            id: 'file-app-py',
            name: 'app.py',
            type: 'file',
            content: `# Python script példa\nimport time\n\ndef ellenorzes():\n    print("Közös kódolás fut...")\n    time.sleep(1)\n    print("Kész!")\n\nif __name__ == '__main__':\n    ellenorzes()\n`
          },
          {
            id: 'file-styles-css',
            name: 'styles.css',
            type: 'file',
            content: `/* Discord stíluslap */\n.editor-container {\n  background-color: #1e1f22;\n  color: #dbdee1;\n  font-family: Consolas, monospace;\n}\n\n.highlight {\n  color: #5865F2;\n}\n`
          }
        ]
      },
      {
        id: 'file-readme',
        name: 'README.md',
        type: 'file',
        content: `# Közös Kód Projekt 🚀\n\nEz egy valós időben megosztott kód editor.\n- Bal oldalon hozhatsz létre új fájlokat és mappákat.\n- A kód automatikusan szinkronizálódik a szobában lévőkkel.\n- Futtatási funkció nincs (csak szerkesztés és kódolás).\n`
      }
    ]
  };
}

function findNodeById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function addNodeToFolder(root, parentId, newNode) {
  const parent = findNodeById(root, parentId || 'root');
  if (parent && parent.type === 'folder') {
    if (!parent.children) parent.children = [];
    parent.children.push(newNode);
    return true;
  }
  return false;
}

function deleteNodeById(root, id) {
  if (id === 'root') return false;
  if (!root.children) return false;

  const idx = root.children.findIndex(c => c.id === id);
  if (idx !== -1) {
    root.children.splice(idx, 1);
    return true;
  }

  for (const child of root.children) {
    if (child.type === 'folder' && deleteNodeById(child, id)) {
      return true;
    }
  }
  return false;
}

function renameNodeById(root, id, newName) {
  const node = findNodeById(root, id);
  if (node && id !== 'root') {
    node.name = newName.trim();
    return true;
  }
  return false;
}

function updateFileContent(root, fileId, content) {
  const node = findNodeById(root, fileId);
  if (node && node.type === 'file') {
    node.content = content;
    return true;
  }
  return false;
}

function sanitizeName(name, fallback) {
  const clean = String(name || '').replace(/[\\/]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

module.exports = function setupCodeEditor(io, users) {
  const projects = new Map(); // channelId -> projektfa

  function getProject(channelId) {
    if (!projects.has(channelId)) {
      projects.set(channelId, getDefaultProjectTree());
    }
    return projects.get(channelId);
  }

  io.on('connection', (socket) => {
    // Csak az a felhasználó módosíthat, aki az adott hangszobában van
    const getMember = (channelId) => {
      const user = users.get(socket.id);
      return user && channelId && user.voiceChannel === channelId ? user : null;
    };

    socket.on('code:get-tree', ({ channelId } = {}) => {
      if (!getMember(channelId)) return;
      socket.emit('code:tree-data', getProject(channelId));
    });

    socket.on('code:create-node', ({ channelId, parentId, name, type } = {}) => {
      const user = getMember(channelId);
      if (!user || (type !== 'file' && type !== 'folder')) return;

      const project = getProject(channelId);
      const newNode = {
        id: `${type}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: sanitizeName(name, type === 'file' ? 'uj_file.js' : 'uj_mappa'),
        type,
        ...(type === 'file' ? { content: '' } : { children: [] })
      };

      if (addNodeToFolder(project, parentId, newNode)) {
        io.to(channelId).emit('code:tree-data', project);
        console.log(`[CodeEditor] Új ${type} létrehozva: "${newNode.name}" (${user.username})`);
      }
    });

    socket.on('code:delete-node', ({ channelId, nodeId } = {}) => {
      const user = getMember(channelId);
      if (!user) return;

      const project = getProject(channelId);
      if (deleteNodeById(project, nodeId)) {
        io.to(channelId).emit('code:tree-data', project);
        console.log(`[CodeEditor] Elem törölve: ${nodeId} (${user.username})`);
      }
    });

    socket.on('code:rename-node', ({ channelId, nodeId, newName } = {}) => {
      const user = getMember(channelId);
      if (!user) return;

      const project = getProject(channelId);
      const name = sanitizeName(newName, '');
      if (name && renameNodeById(project, nodeId, name)) {
        io.to(channelId).emit('code:tree-data', project);
        console.log(`[CodeEditor] Elem átnevezve: "${name}" (${user.username})`);
      }
    });

    socket.on('code:file-change', ({ channelId, fileId, content } = {}) => {
      const user = getMember(channelId);
      if (!user || typeof content !== 'string' || content.length > MAX_FILE_SIZE) return;

      if (updateFileContent(getProject(channelId), fileId, content)) {
        socket.to(channelId).emit('code:file-updated', {
          fileId,
          content,
          senderName: user.username
        });
      }
    });
  });

  return { getProject };
};
