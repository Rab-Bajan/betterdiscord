import type { FolderNode } from './types.ts';

/** The starter project every channel gets on first access (verbatim from codeEditorHandler.js). */
export function createDefaultProject(): FolderNode {
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
