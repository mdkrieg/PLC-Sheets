/**
 * About dialog: a centred modal showing build metadata and third-party
 * attributions. Appears on demand from the title bar.
 *
 * The dialog is rendered into <body> so it isn't constrained by the
 * w2layout's main-panel clip region. Closes on backdrop click or Esc.
 */

interface Attribution {
  name: string;
  license: string;
  url?: string;
}

interface AboutInfo {
  productName: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  attributions: Attribution[];
}

export class AboutDialog {
  private el: HTMLDivElement | null = null;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  async show(): Promise<void> {
    const info = (await window.api.invoke('app:about')) as AboutInfo;
    this.render(info);
  }

  private render(info: AboutInfo): void {
    this.close();
    this.el = document.createElement('div');
    this.el.className = 'about-backdrop';
    this.el.innerHTML = `
      <div class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <h2 id="about-title" style="margin:0 0 4px 0;">${escapeHtml(info.productName)}</h2>
        <div style="color:var(--fg-muted);margin-bottom:12px;">Version ${escapeHtml(info.version)}</div>
        <div style="font-size:12px;color:var(--fg-muted);line-height:1.6;margin-bottom:16px;">
          Electron ${escapeHtml(info.electronVersion)} · Chromium ${escapeHtml(info.chromeVersion)}
          · Node ${escapeHtml(info.nodeVersion)}<br>
          Platform: ${escapeHtml(info.platform)}
        </div>

        <p style="margin:0 0 6px 0;">
          Excel-compatible spreadsheet with inline Modbus PLC communication.
        </p>
        <p style="margin:0 0 12px 0;color:var(--fg-muted);font-size:12px;">
          PLC-Sheets is built on the open-source HyperFormula calculation engine
          under its GPL-3.0 community license. Distribution of this build is
          governed by GPL-3.0 unless a commercial HyperFormula key is supplied.
        </p>

        <h3 style="margin:14px 0 6px 0;font-size:13px;">Third-party attributions</h3>
        <ul class="about-attrib" style="list-style:none;padding:0;margin:0;font-size:12px;max-height:32vh;overflow:auto;border:1px solid var(--border);border-radius:4px;">
          ${info.attributions
            .map(
              (a) => `
            <li style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border);">
              <span style="font-weight:600;min-width:140px;">${escapeHtml(a.name)}</span>
              <span style="color:var(--fg-muted);flex:1;">${escapeHtml(a.license)}</span>
              ${a.url ? `<a href="#" data-url="${escapeAttr(a.url)}" class="about-link">Learn more</a>` : ''}
            </li>`,
            )
            .join('')}
        </ul>

        <div style="text-align:right;margin-top:14px;">
          <button class="w2ui-btn" data-act="close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.el);

    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.querySelector<HTMLButtonElement>('[data-act="close"]')?.addEventListener('click', () => this.close());
    this.el.querySelectorAll<HTMLAnchorElement>('a.about-link').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const url = a.dataset.url;
        if (url) void window.api.invoke('app:openExternal', { url });
      });
    });
    document.addEventListener('keydown', this.keyHandler);
  }

  close(): void {
    document.removeEventListener('keydown', this.keyHandler);
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
