import React, { useState, useEffect } from 'react';
import { X, Check, RefreshCw, Zap } from './Icons';
import { listModels, mixedContentWarning } from '../utils/ollama';

/**
 * Settings for the local AI (Ollama) integration. All values are stored
 * per-device; nothing is sent anywhere except the user's own Ollama server.
 */
const SettingsModal = ({ isOpen, onClose, config, onSave }) => {
  const [enabled, setEnabled] = useState(config.enabled);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [status, setStatus] = useState(null); // { ok, msg }
  const [models, setModels] = useState([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setEnabled(config.enabled);
      setBaseUrl(config.baseUrl);
      setModel(config.model);
      setStatus(null);
      setModels([]);
    }
  }, [isOpen, config]);

  if (!isOpen) return null;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const mixed = mixedContentWarning(baseUrl);

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const found = await listModels(baseUrl);
      setModels(found);
      if (found.length && !found.includes(model)) setModel(found[0]);
      setStatus({ ok: true, msg: found.length ? `Connected · ${found.length} model(s) found` : 'Connected · no models installed yet' });
    } catch (err) {
      setStatus({ ok: false, msg: err.message });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    onSave({ enabled, baseUrl: baseUrl.trim(), model: model.trim() });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-ink/45 backdrop-blur-[2px] flex items-center justify-center p-4" onClick={onClose}>
      <div className="panel w-full max-w-lg p-6 animate-rise-in max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <div className="eyebrow flex items-center gap-1.5"><Zap size={13} className="text-accent" />Local AI</div>
            <h3 className="font-display text-2xl font-semibold text-ink">AI Clue Assist</h3>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X size={20} /></button>
        </div>
        <p className="text-ink-soft text-sm mb-5 leading-relaxed">
          Connect a locally-hosted <span className="font-semibold">Ollama</span> model to draft crossword clues while you build.
          Runs entirely on your machine — nothing is sent to the cloud.
        </p>

        <label className="flex items-center gap-3 mb-4 cursor-pointer select-none">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-accent" />
          <span className="text-sm font-semibold text-ink">Enable AI clue assist</span>
        </label>

        <div className="space-y-4">
          <div>
            <div className="eyebrow mb-1.5">Ollama server URL</div>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434" className="field font-mono text-sm" />
          </div>

          <div>
            <div className="eyebrow mb-1.5">Model</div>
            {models.length > 0 ? (
              <select value={model} onChange={(e) => setModel(e.target.value)} className="field text-sm">
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.1" className="field font-mono text-sm" />
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={test} disabled={testing} className="btn btn-sm">
              <RefreshCw size={14} className={testing ? 'animate-spin' : ''} />{testing ? 'Testing…' : 'Test connection'}
            </button>
            {status && (
              <span className={`text-sm font-medium ${status.ok ? 'text-correct' : 'text-wrong'}`}>{status.msg}</span>
            )}
          </div>
        </div>

        {mixed && (
          <div className="mt-4 text-xs text-wrong bg-wrong/10 border border-wrong/30 rounded-lg px-3 py-2 leading-relaxed">{mixed}</div>
        )}

        <div className="mt-5 text-xs text-ink-faint leading-relaxed border-t border-line pt-4 space-y-2">
          <div className="font-semibold text-ink-soft">Can’t connect? On the machine running Ollama:</div>
          <ul className="list-disc pl-4 space-y-1">
            <li>Install a model: <code className="chip">ollama pull llama3.1</code></li>
            <li>Allow this page: <code className="chip">OLLAMA_ORIGINS={origin || '*'}</code></li>
            <li>Expose beyond localhost (needed for phone / Tailscale): <code className="chip">OLLAMA_HOST=0.0.0.0:11434</code></li>
            <li>Restart Ollama with those set, then <b>Test connection</b>.</li>
          </ul>
          <div>Over <span className="font-semibold">Tailscale</span>, set the URL above to the host’s Tailscale address (e.g. <code className="chip">http://100.x.x.x:11434</code>) — not <code className="chip">localhost</code>.</div>
          <div>From the <span className="font-semibold">deployed HTTPS site</span>, run <code className="chip">tailscale serve --bg --https=443 http://localhost:11434</code> on the Ollama box and paste the printed <code className="chip">https://…ts.net</code> URL above (HTTPS→HTTPS avoids mixed-content blocks).</div>
          <div className="text-ink-faint/80">This page’s origin: <span className="font-mono text-ink-soft break-all">{origin || 'unknown'}</span></div>
        </div>

        {/* Sticky, because the card scrolls internally and on a 844px-tall phone these
            two buttons started ~64px below the fold — reachable, but only if you knew to
            scroll past a long help article to find them. */}
        <div className="flex gap-3 mt-5 sticky bottom-0 -mx-6 px-6 pt-3 pb-1 bg-paper-raised border-t border-line">
          <button onClick={save} className="btn btn-accent flex-1"><Check size={16} />Save</button>
          <button onClick={onClose} className="btn btn-ghost flex-1"><X size={16} />Cancel</button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
