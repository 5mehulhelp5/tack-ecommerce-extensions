/*
 * Net terms on the customer's Profile page (new customer accounts).
 *
 * Identity is the session token and nothing else: Shopify signs it with the app
 * secret and its `sub` is the signed-in customer. No customer id, email or
 * tenant is ever sent from here, so a customer cannot apply as someone else.
 * https://shopify.dev/docs/api/customer-account-ui-extensions/2026-07/target-apis/platform-apis/session-token-api
 *
 * An application grants nothing. It is a request the seller reviews in
 * TackQuote; this block only shows what they decided.
 */
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export const API_BASE = 'https://api.tackquote.com/v1/shopify-app/customer-account';

export default async () => {
  render(<NetTerms />, document.body);
};

/** Authenticated call to the TackQuote API. Tokens live about a minute, so fetch one per request. */
export async function callApi(path, method = 'GET', body = '') {
  const token = await shopify.sessionToken.get();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    body: body || undefined,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(data.message) ? data.message.join(' ') : data.message;
    throw Object.assign(new Error(typeof message === 'string' ? message : `HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return data;
}

/** The request body: required fields trimmed, empty optionals OMITTED (the API refuses null). */
export function buildApplication(form) {
  const text = (key) => String(form[key] || '').trim();
  const limit = Number(form.requestedLimit);
  const hasLimit = form.requestedLimit !== '' && form.requestedLimit != null && Number.isFinite(limit) && limit > 0;
  const days = Number(form.requestedTermsDays);
  return {
    legalBusinessName: text('legalBusinessName'),
    contactEmail: text('contactEmail'),
    ...(text('contactPhone') ? { contactPhone: text('contactPhone') } : {}),
    ...(text('taxId') ? { taxId: text('taxId') } : {}),
    ...(text('notes') ? { notes: text('notes') } : {}),
    ...(hasLimit ? { requestedLimit: limit } : {}),
    ...(Number.isInteger(days) && days > 0 ? { requestedTermsDays: days } : {}),
  };
}

/** Pure: which view a status answer maps to. */
export function viewFor(status) {
  if (!status) return 'loading';
  if (status.state === 'approved') return 'approved';
  if (status.state === 'pending') return 'pending';
  if (status.state === 'declined') return 'declined';
  return 'apply';
}

function NetTerms() {
  const t = (key, options = {}) => shopify.i18n.translate(key, options);
  const [status, setStatus] = useState(null);
  const [problem, setProblem] = useState('');
  const [form, setForm] = useState({ requestedTermsDays: '30' });
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = () =>
    callApi('/net-terms')
      .then((data) => {
        setStatus(data);
        setProblem('');
      })
      .catch((err) => setProblem(err.status === 404 ? t('notConnected') : t('loadFailed')));

  useEffect(() => {
    load();
  }, []);

  const field = (key) => (event) => setForm({ ...form, [key]: event.currentTarget.value });

  // s-form handles submission itself (no navigation), so there is nothing to prevent.
  const submit = () => {
    const body = buildApplication(form);
    if (!body.legalBusinessName || !body.contactEmail) {
      setProblem(t('required'));
      return;
    }
    setSending(true);
    setProblem('');
    callApi('/net-terms', 'POST', JSON.stringify(body))
      .then(() => {
        setApplying(false);
        return load();
      })
      .catch((err) => setProblem(err.status === 400 ? err.message : t('sendFailed')))
      .finally(() => setSending(false));
  };

  const view = viewFor(status);

  if (problem && !status) {
    return (
      <s-section heading={t('heading')}>
        <s-banner tone="warning">{problem}</s-banner>
      </s-section>
    );
  }

  if (view === 'loading') {
    return (
      <s-section heading={t('heading')}>
        <s-skeleton-paragraph content={t('loading')}></s-skeleton-paragraph>
      </s-section>
    );
  }

  const account = status.account;
  const application = status.application;

  return (
    <s-section heading={t('heading')}>
      <s-stack direction="block" gap="base">
        {view === 'approved' && (
          <s-stack direction="block" gap="small">
            <s-badge tone="auto" icon="check-circle">{t('state.approved')}</s-badge>
            {account && account.termsDays ? (
              <s-text>{t('termsDays', { days: account.termsDays })}</s-text>
            ) : null}
            {account && account.creditLimit ? (
              <s-text>
                {t('limit', {
                  amount: shopify.i18n.formatCurrency(Number(account.creditLimit), {
                    currency: account.currency,
                  }),
                })}
              </s-text>
            ) : null}
          </s-stack>
        )}

        {view === 'pending' && (
          <s-stack direction="block" gap="small">
            <s-badge tone="neutral">{t('state.pending')}</s-badge>
            <s-text>{t('pendingBody')}</s-text>
            {application && application.submittedAt ? (
              <s-text color="subdued">
                {t('submittedOn', { date: shopify.i18n.formatDate(new Date(application.submittedAt)) })}
              </s-text>
            ) : null}
          </s-stack>
        )}

        {view === 'declined' && (
          <s-stack direction="block" gap="small">
            <s-badge tone="critical">{t('state.declined')}</s-badge>
            <s-text>{t('declinedBody')}</s-text>
          </s-stack>
        )}

        {view === 'apply' && !applying && (
          <s-stack direction="block" gap="small">
            <s-text>{t('intro')}</s-text>
            <s-button variant="primary" onClick={() => setApplying(true)}>
              {t('apply')}
            </s-button>
          </s-stack>
        )}

        {view === 'declined' && !applying && (
          <s-button variant="secondary" onClick={() => setApplying(true)}>
            {t('applyAgain')}
          </s-button>
        )}

        {applying && (
          <s-form onSubmit={() => submit()}>
            <s-stack direction="block" gap="base">
              <s-text-field label={t('field.business')} name="legalBusinessName" required onInput={field('legalBusinessName')}></s-text-field>
              <s-email-field label={t('field.email')} name="contactEmail" autocomplete="email" required onInput={field('contactEmail')}></s-email-field>
              <s-phone-field label={t('field.phone')} name="contactPhone" autocomplete="tel" onInput={field('contactPhone')}></s-phone-field>
              <s-text-field label={t('field.taxId')} name="taxId" onInput={field('taxId')}></s-text-field>
              <s-number-field label={t('field.limit')} name="requestedLimit" min={0} inputMode="decimal" onInput={field('requestedLimit')}></s-number-field>
              <s-select label={t('field.terms')} name="requestedTermsDays" value={form.requestedTermsDays} onChange={field('requestedTermsDays')}>
                <s-option value="15">{t('days', { days: 15 })}</s-option>
                <s-option value="30">{t('days', { days: 30 })}</s-option>
                <s-option value="45">{t('days', { days: 45 })}</s-option>
                <s-option value="60">{t('days', { days: 60 })}</s-option>
                <s-option value="90">{t('days', { days: 90 })}</s-option>
              </s-select>
              <s-text-area label={t('field.notes')} name="notes" rows={3} maxLength={500} onInput={field('notes')}></s-text-area>
              {problem ? <s-banner tone="critical">{problem}</s-banner> : null}
              <s-button type="submit" variant="primary" disabled={sending}>
                {sending ? t('sending') : t('send')}
              </s-button>
            </s-stack>
          </s-form>
        )}
      </s-stack>
    </s-section>
  );
}
