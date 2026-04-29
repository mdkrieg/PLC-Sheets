/**
 * Title bar: filename + modified date + Open/Save/Save As/Connect/Writes-Enabled/Theme.
 *
 * Phase 2 wires Open/Save/Save-As callbacks. Connect & Writes-Enabled remain
 * stubbed until Phase 4.
 */

export interface TitleBarCallbacks {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onConnect: () => void;
  onWrites: () => void;
  onAbout: () => void;
}

interface TitleBarState {
  fileName: string;
  modifiedAt: string | null;
  connected: boolean;
  writesEnabled: boolean;
  dirty: boolean;
}

export class TitleBar {
  private state: TitleBarState = {
    fileName: 'No file open',
    modifiedAt: null,
    connected: false,
    writesEnabled: false,
    dirty: false,
  };

  constructor(private host: HTMLElement, private callbacks: TitleBarCallbacks) {}

  render(): void {
    const { fileName, modifiedAt, connected, writesEnabled, dirty } = this.state;
    const modified = modifiedAt ? `<span class="modified">modified ${formatTs(modifiedAt)}</span>` : '';
    const dirtyMark = dirty ? '<span class="modified" style="color:var(--danger)">●</span>' : '';

    this.host.innerHTML = `
      <div class="filename">${escape(fileName)} ${dirtyMark}${modified}</div>
      <button class="w2ui-btn" data-act="open">Open</button>
      <button class="w2ui-btn" data-act="save">Save</button>
      <button class="w2ui-btn" data-act="save-as">Save As</button>
      <button class="w2ui-btn connect-btn ${connected ? 'connected' : ''}" data-act="connect">
        ${connected ? 'Disconnect' : 'Connect'}
      </button>
      <button class="w2ui-btn writes-toggle ${writesEnabled ? 'armed' : ''}" data-act="writes">
        Writes ${writesEnabled ? 'ENABLED' : 'disabled'}
      </button>
      <button class="w2ui-btn" data-act="theme">Theme</button>
      <button class="w2ui-btn" data-act="about">About</button>
    `;

    this.host.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => this.handle(btn.dataset.act!));
    });
  }

  private handle(action: string): void {
    switch (action) {
      case 'open':
        this.callbacks.onOpen();
        break;
      case 'save':
        this.callbacks.onSave();
        break;
      case 'save-as':
        this.callbacks.onSaveAs();
        break;
      case 'connect':
        this.callbacks.onConnect();
        break;
      case 'writes':
        this.callbacks.onWrites();
        this.state.writesEnabled = !this.state.writesEnabled;
        this.render();
        break;
      case 'theme':
        this.toggleTheme();
        break;
      case 'about':
        this.callbacks.onAbout();
        break;
    }
  }

  private toggleTheme(): void {
    const body = document.body;
    if (body.classList.contains('theme-dark')) {
      body.classList.remove('theme-dark');
      body.classList.add('theme-light');
    } else {
      body.classList.remove('theme-light');
      body.classList.add('theme-dark');
    }
  }

  setFile(fileName: string, modifiedAt: string | null): void {
    this.state.fileName = fileName;
    this.state.modifiedAt = modifiedAt;
    this.render();
  }

  setConnected(connected: boolean): void {
    this.state.connected = connected;
    this.render();
  }

  setDirty(dirty: boolean): void {
    if (this.state.dirty === dirty) return;
    this.state.dirty = dirty;
    this.render();
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
