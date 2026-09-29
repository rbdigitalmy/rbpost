'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Check, Info, Link2, PauseCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import { api, AtThreads, Empty, PageHeader, useWorkspace } from './workspace';
import { AtInstagram, Modal, Spinner } from './ui';
import {
  type AutomationAccount,
  type AutomationPlatform,
  type AutomationRuleInput,
  capabilityLabels,
  grantedCapabilities,
  missingScopes,
  reconnectRequired,
  runActionLabels,
  threadsReplyMax,
} from '@/lib/automation';
import { dateLabel } from '@/lib/domain';

const emptyRule: AutomationRuleInput = {
  enabled: false,
  comment_reply_enabled: false,
  comment_reply_template: '',
  private_reply_enabled: false,
  private_reply_template: '',
  dm_reply_enabled: false,
  dm_reply_template: '',
  threads_reply_enabled: false,
  threads_reply_template: '',
  keywords: [],
  exclude_keywords: [],
  cooldown_minutes: 60,
};

/** Demo accounts mirror the sample connections; nothing is sent or saved on a server. */
function demoAccounts(accounts: { platform: AutomationPlatform; id: string; username: string }[]): AutomationAccount[] {
  return accounts.map(a => ({
    id: a.id,
    platform: a.platform,
    username: a.username,
    status: 'connected',
    expires_at: null,
    scopes: null,
    capabilities: [],
    reconnect_required: false,
    rule: null,
    last_success_at: null,
    recent_failures: [],
  }));
}

export function AutomationsView() {
  const { data, demo, notify, base } = useWorkspace();
  const [accounts, setAccounts] = useState<AutomationAccount[] | null>(null);
  const [error, setError] = useState('');
  const [pausing, setPausing] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const load = useCallback(async () => {
    if (demo) {
      const sample = [data.accounts?.threads, data.accounts?.instagram].filter((a): a is NonNullable<typeof a> => !!a);
      setAccounts(demoAccounts(sample));
      return;
    }
    setAccounts(await api<AutomationAccount[]>('automations'));
  }, [demo, data.accounts]);
  useEffect(() => {
    load().catch(e => setError((e as Error).message));
  }, [load]);
  const anyEnabled = !!accounts?.some(a => a.rule?.enabled);
  async function pauseAll() {
    setPausing(true);
    try {
      if (demo) setAccounts(list => list?.map(a => ({ ...a, rule: a.rule && { ...a.rule, enabled: false } })) || null);
      else {
        await api('automations/pause-all', {});
        await load();
      }
      setConfirmPause(false);
      notify('All automations are paused. No new automated replies will be sent.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPausing(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="REPLY WHILE YOU CREATE"
        title="Automations"
        description="Send your own template replies to new comments, messages and Threads replies."
      >
        <button className="btn danger" disabled={!anyEnabled || pausing} onClick={() => setConfirmPause(true)}>
          <PauseCircle size={17} />
          Pause all
        </button>
      </PageHeader>
      <div className="notice warning">
        <Info size={18} />
        <span>
          Instagram only lets you message people who contacted you first. Replies to DMs must be sent within 24 hours of
          their message, and one private reply per comment within 7 days. RB Post never sends cold DMs.
        </span>
      </div>
      <div className="notice">
        <Info size={18} />
        <span>Threads automation posts public replies under your posts. Threads has no DM automation.</span>
      </div>
      {demo && (
        <div className="notice">
          <Info size={18} />
          <span>Demo mode: settings stay in this page and no replies are sent.</span>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!accounts ? (
        error ? null : (
          <Spinner />
        )
      ) : !accounts.length ? (
        <Empty title="No connected accounts" description="Connect Threads or Instagram to set up automated replies.">
          <Link className="btn secondary" href={`${base}/connections`}>
            <Link2 size={16} />
            Go to connections
          </Link>
        </Empty>
      ) : (
        accounts.map(account => (
          <AccountAutomation
            // Remount when the stored rule changes (e.g. Pause all) so the form never shows stale switches.
            key={`${account.id}:${account.rule?.updated_at || ''}:${account.rule?.enabled ?? 'none'}`}
            account={account}
            onSaved={next => setAccounts(list => list?.map(a => (a.id === next.id ? next : a)) || null)}
          />
        ))
      )}
      {confirmPause && (
        <Modal
          title="Pause every automation?"
          onClose={() => {
            if (!pausing) setConfirmPause(false);
          }}
        >
          <div className="form-fields">
            <p>Automated replies stop immediately on all accounts, including replies already waiting to be sent.</p>
            <button className="btn danger" disabled={pausing} onClick={pauseAll}>
              {pausing ? <Spinner /> : <PauseCircle size={16} />}Pause all automations
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function listToText(list: string[]) {
  return list.join(', ');
}
function textToList(value: string) {
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="switch-row" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

function AccountAutomation({
  account,
  onSaved,
}: {
  account: AutomationAccount;
  onSaved: (account: AutomationAccount) => void;
}) {
  const { data, demo, notify, base } = useWorkspace();
  const [rule, setRule] = useState<AutomationRuleInput>(account.rule ? { ...emptyRule, ...account.rule } : emptyRule);
  const [keywords, setKeywords] = useState(listToText(rule.keywords));
  const [exclusions, setExclusions] = useState(listToText(rule.exclude_keywords));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const instagram = account.platform === 'instagram';
  const blocked = !demo && (account.reconnect_required || account.status !== 'connected');
  const set = <K extends keyof AutomationRuleInput>(key: K, value: AutomationRuleInput[K]) =>
    setRule(r => ({ ...r, [key]: value }));
  const granted = demo ? [] : grantedCapabilities(account.platform, account.scopes);
  const missing = missingScopes(account.platform, account.scopes);
  const prefix = `automation-${account.id}`;

  async function save() {
    setBusy(true);
    setError('');
    try {
      const input = { ...rule, keywords: textToList(keywords), exclude_keywords: textToList(exclusions) };
      if (demo) {
        onSaved({
          ...account,
          rule: { ...input, id: account.id, social_account_id: account.id, platform: account.platform, updated_at: '' },
        });
        notify('Demo settings updated. No replies are sent in demo mode.');
        return;
      }
      const result = await api<{ rule: AutomationAccount['rule']; webhooks: string }>(
        `automations/${account.id}`,
        input,
        'PATCH',
      );
      onSaved({ ...account, rule: result.rule });
      notify(
        result.webhooks === 'pending'
          ? 'Saved. Instagram notifications are not active yet; reconnect Instagram if replies do not start.'
          : 'Automation settings saved.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-panel automation-panel" aria-labelledby={`${prefix}-title`}>
      <div className="panel-heading">
        <div className="inline-heading">
          <span className={`network-icon ${instagram ? 'instagram-icon' : 'threads-icon'}`}>
            {instagram ? <AtInstagram size={26} /> : <AtThreads size={22} />}
          </span>
          <div>
            <h2 id={`${prefix}-title`}>
              {instagram ? 'Instagram' : 'Threads'} · @{account.username}
            </h2>
            <p>
              {account.last_success_at
                ? `Last automated reply ${dateLabel(account.last_success_at, data.profile.timezone, 'd MMM, HH:mm')}`
                : 'No automated replies sent yet.'}
            </p>
          </div>
        </div>
        <span className={`pill ${blocked ? '' : account.rule?.enabled ? 'success-pill' : ''}`}>
          {blocked ? 'Reconnect required' : account.rule?.enabled ? 'On' : 'Off'}
        </span>
      </div>
      <div className="form-fields">
        {blocked && (
          <div className="notice warning">
            <ShieldCheck size={18} />
            <span>
              {account.status !== 'connected'
                ? 'This connection has expired. '
                : `This account was connected before automation was available, or a permission was not granted. `}
              Open <Link href={`${base}/connections`}>Connections</Link>, choose Reconnect and allow every permission
              {missing.length ? ` (${missing.join(', ')})` : ''}. Publishing keeps working meanwhile.
            </span>
          </div>
        )}
        {!demo && (
          <div className="capability-list" aria-label="Granted capabilities">
            {(instagram ? (['publish', 'comments', 'messages'] as const) : (['publish', 'replies'] as const)).map(c => (
              <span key={c} className={`pill ${granted.includes(c) ? 'success-pill' : ''}`}>
                {granted.includes(c) ? <Check size={12} /> : null}
                {capabilityLabels[c]}
              </span>
            ))}
          </div>
        )}
        <fieldset className="form-fields" disabled={busy || blocked}>
          <Toggle
            id={`${prefix}-enabled`}
            label="Automation for this account"
            hint="Switching this off stops every automated reply immediately."
            checked={rule.enabled}
            onChange={v => set('enabled', v)}
          />
          {instagram ? (
            <>
              <Toggle
                id={`${prefix}-comment`}
                label="Reply publicly to new comments"
                hint="Top-level comments on your posts. Replies to replies are skipped."
                checked={rule.comment_reply_enabled}
                onChange={v => set('comment_reply_enabled', v)}
              />
              <label>
                Public comment reply
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={rule.comment_reply_template}
                  onChange={e => set('comment_reply_template', e.target.value)}
                  placeholder="e.g. Thanks! We just sent you the details."
                />
              </label>
              <Toggle
                id={`${prefix}-private`}
                label="Also send a private reply to the commenter"
                hint="One message per comment, within 7 days of the comment, as Meta allows."
                checked={rule.private_reply_enabled}
                onChange={v => set('private_reply_enabled', v)}
              />
              <label>
                Private reply message
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={rule.private_reply_template}
                  onChange={e => set('private_reply_template', e.target.value)}
                  placeholder="e.g. Hi! Here is the link you asked about: …"
                />
              </label>
              <Toggle
                id={`${prefix}-dm`}
                label="Auto-reply to new DMs"
                hint="Only to people who messaged you, within 24 hours of their message."
                checked={rule.dm_reply_enabled}
                onChange={v => set('dm_reply_enabled', v)}
              />
              <label>
                DM reply
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={rule.dm_reply_template}
                  onChange={e => set('dm_reply_template', e.target.value)}
                  placeholder="e.g. Thanks for your message! We reply within one working day."
                />
              </label>
            </>
          ) : (
            <>
              <Toggle
                id={`${prefix}-threads`}
                label="Reply to new replies on your threads"
                hint="Posts a public reply under direct replies to your posts from the last 7 days."
                checked={rule.threads_reply_enabled}
                onChange={v => set('threads_reply_enabled', v)}
              />
              <label>
                Threads reply
                <textarea
                  rows={2}
                  maxLength={threadsReplyMax}
                  value={rule.threads_reply_template}
                  onChange={e => set('threads_reply_template', e.target.value)}
                  placeholder="e.g. Thanks for joining the conversation!"
                />
              </label>
            </>
          )}
          <div className="form-grid">
            <label>
              Only reply when the text contains
              <input
                value={keywords}
                maxLength={1100}
                onChange={e => setKeywords(e.target.value)}
                placeholder="Any text (leave empty)"
              />
              <small className="muted">Comma-separated, not case-sensitive.</small>
            </label>
            <label>
              Never reply when the text contains
              <input
                value={exclusions}
                maxLength={1100}
                onChange={e => setExclusions(e.target.value)}
                placeholder="e.g. spam, unsubscribe"
              />
              <small className="muted">Exclusions always win.</small>
            </label>
          </div>
          <label>
            Wait before replying to the same person again (minutes)
            <input
              type="number"
              min={1}
              max={1440}
              value={rule.cooldown_minutes}
              onChange={e => set('cooldown_minutes', Math.max(1, Math.min(1440, Number(e.target.value) || 1)))}
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="button-row">
            <button type="button" className="btn primary" onClick={save}>
              {busy ? <Spinner /> : <Check size={16} />}Save automation
            </button>
          </div>
        </fieldset>
        {account.recent_failures.length > 0 && (
          <div className="automation-failures">
            <h3>Recent problems</h3>
            <ul>
              {account.recent_failures.map(run => (
                <li key={run.id}>
                  <span className={`badge ${run.status === 'uncertain' ? 'publishing' : 'failed'}`}>
                    <span />
                    {run.status === 'uncertain' ? 'Unverified' : 'Failed'}
                  </span>
                  <b>{runActionLabels[run.action]}</b>
                  <span>{run.error_message || 'Meta rejected this reply.'}</span>
                  <small className="muted">{dateLabel(run.created_at, data.profile.timezone, 'd MMM, HH:mm')}</small>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** Reconnect guidance shown on the Connections page for accounts missing automation permissions. */
export function ReconnectNotice({ platform, scopes }: { platform: AutomationPlatform; scopes?: string[] | null }) {
  if (!reconnectRequired({ platform, scopes })) return null;
  return (
    <div className="notice warning">
      <RotateCcw size={18} />
      <span>
        <b>Reconnect required for automations.</b> This connection was made before comment, message and reply
        permissions were requested. Choose Reconnect below and allow every permission. Publishing keeps working until
        then.
      </span>
    </div>
  );
}
