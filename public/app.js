/* public/app.js */
import { 
  t, setLocale, getLocale, 
  getCompactRoleName, getCompactModelName, 
  getCompactTemplateName, getCompactIntentName, getCompactArbitrationText 
} from './i18n.js?v=1791547200000';

function localToast(message, type = 'error') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

let user = null;
let selectedFiles = [];
const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILES = 5;

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(size < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// --- Secure Markdown Sanitization Pipeline (DOMPurify + marked) ---
function safeRenderMarkdown(rawText) {
  if (!rawText) return '';
  let html = '';
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      html = window.marked.parse(rawText);
    } catch (e) {
      html = `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(rawText)}</pre>`;
    }
  } else {
    html = `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(rawText)}</pre>`;
  }

  // Sanitize with DOMPurify if present to eliminate any XSS vulnerability
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
    });
  }

  return html;
}
window.safeRenderMarkdown = safeRenderMarkdown;
window.renderMarkdownToHtml = safeRenderMarkdown;

window.showModal = function(title, body, primaryText = null, primaryAction = null, showCancel = true) {
  document.getElementById('modal-title').innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--accent-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
    <span>${title}</span>
  `;
  document.getElementById('modal-body').innerHTML = body;
  
  const primaryBtn = document.getElementById('modal-primary-btn');
  if (primaryBtn) {
    primaryBtn.textContent = primaryText || t('common.gotIt');
    primaryBtn.onclick = () => {
      if (primaryAction) primaryAction();
      else window.hideModal();
    };
  }
  
  const cancelBtn = document.querySelector('#modal-footer .btn-outline');
  if (cancelBtn) {
    cancelBtn.style.display = showCancel ? 'inline-block' : 'none';
  }
  
  document.getElementById('modal-overlay').classList.add('active');
}

window.hideModal = function() {
  document.getElementById('modal-overlay').classList.remove('active');
}

window.cachedOAuthBindings = [];

function setupBindButton(provider, currentBindings) {
  const btn = document.getElementById(`bind-${provider}-btn`);
  if (!btn) return;
  const isBound = Array.isArray(currentBindings) && currentBindings.includes(provider);
  
  const isEn = getLocale() === 'en';
  if (isBound) {
    btn.setAttribute('data-i18n', 'settings.account.unbind');
    btn.textContent = isEn ? 'Unlink' : '解绑';
    btn.className = 'oauth-btn-text unbind';
    btn.onclick = () => {
      window.showModal(
        isEn ? 'Confirm Unlink' : '确认解绑',
        `<p style="margin-bottom: 1rem; color: var(--text-secondary);">${isEn ? `Are you sure you want to unlink ${provider}? You may no longer be able to log in with this account.` : `您确定要解绑 ${provider} 吗？解绑后您可能无法通过该渠道登录。`}</p>`,
        isEn ? 'Unlink' : '确认解绑',
        async () => {
          window.hideModal();
          try {
            const res = await fetch(`/api/auth/oauth/${provider}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) {
              await window.refreshOAuthBindings();
            } else {
              setTimeout(() => {
                const errStr = data.error === 'Cannot unbind last login method without a password.' ? t('error.cannotUnbind') : (data.error || t('error.unbindFailed'));
                window.showModal(t('error.unbindFailedTitle'), `<p style="color: var(--error-color)">${errStr}</p>`, null, null, false);
              }, 300);
            }
          } catch (e) {
            setTimeout(() => {
              window.showModal(t('error.unbindFailedTitle'), `<p style="color: var(--error-color)">${t('error.unbindFailed')}</p>`, null, null, false);
            }, 300);
          }
        }
      );
    };
  } else {
    btn.setAttribute('data-i18n', 'settings.account.bind');
    btn.textContent = isEn ? 'Link' : '绑定';
    btn.className = 'oauth-btn-text bind';
    btn.onclick = () => {
      window.location.href = `/api/auth/${provider}?action=bind`;
    };
  }
}

window.refreshOAuthBindings = async function() {
  try {
    const bindRes = await fetch('/api/user/bindings');
    if (bindRes.ok) {
      const data = await bindRes.json();
      window.cachedOAuthBindings = Array.isArray(data.bindings) ? data.bindings : [];
      setupBindButton('github', window.cachedOAuthBindings);
      setupBindButton('google', window.cachedOAuthBindings);
    }
  } catch (e) {
    console.error('Failed to fetch bindings', e);
  }
};

// --- Passkey (WebAuthn) Management ---
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function getDefaultDeviceName() {
  const isEn = (localStorage.getItem('nanomesh-lang') || (window.i18n ? window.i18n.getLocale() : 'zh')) === 'en';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return isEn ? 'Apple Device' : '苹果设备';
  if (/Mac OS X/.test(ua)) return isEn ? 'MacBook / Mac' : 'Mac 设备';
  if (/Windows/.test(ua)) return 'Windows Hello';
  if (/Android/.test(ua)) return isEn ? 'Android Device' : '安卓设备';
  if (/Linux/.test(ua)) return isEn ? 'Linux Device' : 'Linux 设备';
  return isEn ? 'Passkey' : '通行密钥';
}

function promptPasskeyName(defaultName) {
  return new Promise((resolve) => {
    const isEn = (localStorage.getItem('nanomesh-lang') || (window.i18n ? window.i18n.getLocale() : 'zh')) === 'en';
    const title = isEn ? 'Name Your Passkey' : '设置密钥名称';
    const desc = isEn 
      ? 'Set a recognizable name for this device before registering:' 
      : '请在验证前为该通行密钥设置一个便于识别的备注名称：';
    const inputLabel = isEn ? 'Device Name' : '设备名称';
    const placeholder = isEn ? 'e.g. MacBook Touch ID, Windows Hello' : '例如：MacBook 指纹、Windows Hello';
    const confirmText = isEn ? 'Continue & Verify' : '下一步 · 验证硬件';
    const cancelText = isEn ? 'Cancel' : '取消';

    const bodyHtml = `
      <div style="margin: 0.25rem 0;">
        <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: 0.85rem;">
          ${desc}
        </p>
        <div style="display: flex; flex-direction: column; gap: 0.4rem;">
          <label style="font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em;">${inputLabel}</label>
          <input type="text" id="modal-passkey-name-input" class="input-field" 
            value="${(defaultName || '').replace(/"/g, '&quot;')}" 
            placeholder="${placeholder}" 
            style="width: 100%; box-sizing: border-box; padding: 0.65rem 0.85rem; border-radius: 8px; font-size: 0.9rem;"
            maxlength="40"
          />
        </div>
      </div>
    `;

    const cancelBtn = document.querySelector('#modal-footer .btn-outline');
    if (cancelBtn) {
      cancelBtn.textContent = cancelText;
      cancelBtn.onclick = () => {
        window.hideModal();
        resolve(null);
      };
    }

    window.showModal(
      title,
      bodyHtml,
      confirmText,
      () => {
        const input = document.getElementById('modal-passkey-name-input');
        const val = input ? input.value.trim() : '';
        window.hideModal();
        resolve(val || defaultName);
      },
      true
    );

    setTimeout(() => {
      const input = document.getElementById('modal-passkey-name-input');
      if (input) {
        input.focus();
        input.select();
        input.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const primaryBtn = document.getElementById('modal-primary-btn');
            if (primaryBtn) primaryBtn.click();
          }
        };
      }
    }, 60);
  });
}

function confirmPasskeyDelete(deviceName) {
  return new Promise((resolve) => {
    const isEn = (localStorage.getItem('nanomesh-lang') || (window.i18n ? window.i18n.getLocale() : 'zh')) === 'en';
    const title = isEn ? 'Delete Passkey' : '删除通行密钥';
    const safeName = (deviceName || (isEn ? 'Passkey' : '通行密钥')).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bodyHtml = `
      <p style="color: var(--text-secondary); font-size: 0.875rem; line-height: 1.5; margin: 0.25rem 0;">
        ${isEn 
          ? `Are you sure you want to delete passkey <strong>${safeName}</strong>? You will no longer be able to use this device to sign in.` 
          : `确定要删除通行密钥 <strong>${safeName}</strong> 吗？删除后将无法使用该设备进行免密登录。`}
      </p>
    `;
    const cancelBtn = document.querySelector('#modal-footer .btn-outline');
    if (cancelBtn) {
      cancelBtn.textContent = isEn ? 'Cancel' : '取消';
      cancelBtn.onclick = () => {
        window.hideModal();
        resolve(false);
      };
    }

    window.showModal(
      title,
      bodyHtml,
      isEn ? 'Delete' : '确认删除',
      () => {
        window.hideModal();
        resolve(true);
      },
      true
    );
  });
}

window.refreshPasskeys = async function() {
  const container = document.getElementById('passkey-list-container');
  if (!container) return;

  const isEn = (localStorage.getItem('nanomesh-lang') || (window.i18n ? window.i18n.getLocale() : 'zh')) === 'en';
  const emptyText = isEn ? 'No passkeys registered yet. Click the button above to add one.' : '暂未绑定通行密钥，点击右上角添加';
  const addedLabel = isEn ? 'Added' : '添加于';
  const lastUsedLabel = isEn ? 'Last used' : '最后使用';
  const defaultName = isEn ? 'My Passkey' : '我的通行密钥';
  const deleteTitle = isEn ? 'Delete Passkey' : '删除密钥';

  try {
    const res = await fetch('/api/auth/passkey/list');
    if (!res.ok) {
      container.innerHTML = `<div class="passkey-empty" style="text-align: center; padding: 1.25rem 0; color: var(--text-secondary); font-size: 0.85rem;">${emptyText}</div>`;
      return;
    }
    const data = await res.json();
    const passkeys = Array.isArray(data.passkeys) ? data.passkeys : [];

    if (passkeys.length === 0) {
      container.innerHTML = `<div class="passkey-empty" style="text-align: center; padding: 1.25rem 0; color: var(--text-secondary); font-size: 0.85rem;">${emptyText}</div>`;
      return;
    }

    container.innerHTML = passkeys.map(pk => {
      const addedDate = pk.created_at ? pk.created_at.split(' ')[0] : '-';
      const lastUsedDate = pk.last_used_at ? pk.last_used_at.split(' ')[0] : '-';
      const safeName = (pk.device_name || defaultName).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <div class="passkey-item">
          <div class="passkey-item-left">
            <div class="passkey-item-icon">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="7.5" cy="15.5" r="4.5"></circle>
                <path d="m21 2-9.6 9.6"></path>
                <path d="m15.5 7.5 3 3"></path>
              </svg>
            </div>
            <div class="passkey-item-info">
              <div class="passkey-item-name">${safeName}</div>
              <div class="passkey-item-meta">${addedLabel} ${addedDate} · ${lastUsedLabel} ${lastUsedDate}</div>
            </div>
          </div>
          <button class="passkey-btn-delete" data-id="${pk.credential_id}" data-name="${safeName}" title="${deleteTitle}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;
    }).join('');

    // Bind delete buttons using custom modal
    container.querySelectorAll('.passkey-btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const credId = btn.getAttribute('data-id');
        const deviceName = btn.getAttribute('data-name');
        if (!credId) return;

        const confirmed = await confirmPasskeyDelete(deviceName);
        if (!confirmed) return;

        btn.disabled = true;
        btn.style.opacity = '0.5';

        try {
          const delRes = await fetch(`/api/auth/passkey/${encodeURIComponent(credId)}`, {
            method: 'DELETE'
          });
          const delData = await delRes.json().catch(() => ({}));

          if (delRes.ok) {
            localToast(isEn ? 'Passkey deleted' : '通行密钥已删除', 'success');
            await window.refreshPasskeys();
          } else {
            localToast(t(delData.error || 'error.deleteFailed'));
            btn.disabled = false;
            btn.style.opacity = '1';
          }
        } catch (err) {
          localToast(t('error.networkError'));
          btn.disabled = false;
          btn.style.opacity = '1';
        }
      });
    });
  } catch (err) {
    console.error('Failed to load passkeys:', err);
    container.innerHTML = `<div class="passkey-empty" style="text-align: center; padding: 1.25rem 0; color: var(--text-secondary); font-size: 0.85rem;">${emptyText}</div>`;
  }
};

window.handleAddPasskey = async function() {
  const isEn = (localStorage.getItem('nanomesh-lang') || (window.i18n ? window.i18n.getLocale() : 'zh')) === 'en';

  if (!window.PublicKeyCredential) {
    localToast(t('auth.passkeyUnsupported'));
    return;
  }

  // 1. Show custom modal for device name FIRST (no native prompt!)
  const chosenName = await promptPasskeyName(getDefaultDeviceName());
  if (chosenName === null) {
    // User cancelled modal
    return;
  }

  const addBtn = document.getElementById('btn-add-passkey');
  const originalHtml = addBtn ? addBtn.innerHTML : '';
  if (addBtn) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.6';
  }

  try {
    const optRes = await fetch('/api/auth/passkey/register/options', { method: 'POST' });
    if (!optRes.ok) {
      const err = await optRes.json().catch(() => ({}));
      localToast(t(err.error || 'error.networkError'));
      return;
    }

    const options = await optRes.json();
    options.challenge = base64UrlToBuffer(options.challenge);
    options.user.id = base64UrlToBuffer(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map(c => ({
        ...c,
        id: base64UrlToBuffer(c.id)
      }));
    }

    localToast(isEn ? 'Please complete biometric or key touch...' : '请在弹出的系统对话框中验证指纹或安全密钥...', 'info');

    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) {
      localToast(t('auth.passkeyCancelled'));
      return;
    }

    const verifyPayload = {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      deviceName: chosenName.trim(),
      response: {
        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64Url(credential.response.attestationObject),
        publicKey: credential.response.getPublicKey ? bufferToBase64Url(credential.response.getPublicKey()) : null,
        publicKeyAlgorithm: credential.response.getPublicKeyAlgorithm ? credential.response.getPublicKeyAlgorithm() : -7,
        transports: credential.response.getTransports ? credential.response.getTransports() : ['internal']
      }
    };

    const verifyRes = await fetch('/api/auth/passkey/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyPayload)
    });

    if (verifyRes.ok) {
      localToast(isEn ? 'Passkey registered successfully' : '通行密钥已成功添加', 'success');
      await window.refreshPasskeys();
    } else {
      const err = await verifyRes.json().catch(() => ({}));
      localToast(t(err.error || 'error.networkError'));
    }
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      localToast(t('auth.passkeyCancelled'));
    } else {
      console.error('[Passkey] Registration error:', err);
      localToast(t('error.networkError'));
    }
  } finally {
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.style.opacity = '1';
      if (originalHtml) addBtn.innerHTML = originalHtml;
    }
  }
};

document.addEventListener('DOMContentLoaded', async () => {

  // Billing Filters
  const billingFilters = document.querySelectorAll('.billing-filter-pill');
  if (billingFilters.length > 0) {
    billingFilters.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetBtn = e.target.closest('.billing-filter-pill');
        if (!targetBtn) return;
        billingFilters.forEach(b => b.classList.remove('active'));
        targetBtn.classList.add('active');
        const filter = targetBtn.getAttribute('data-filter');
        window.currentBillingFilter = filter;
        window.loadBillingLedger(filter);
      });
    });
  }
  
  
  window.ledgerCache = {};
  
  function renderLedger(data) {
    const tbody = document.getElementById('billing-tbody');
    if (!tbody) return;
    
    const gasEl = document.querySelector('.billing-hero-metric .billing-metric-value.text-emerald');
    if (gasEl) {
      gasEl.innerHTML = '+' + data.gasEarnedTotal + ' ⚡';
    }
    
    tbody.innerHTML = '';
    if (data.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; font-size: 0.85rem; color: var(--text-secondary); padding: 2.5rem 0;">' + t('billing.empty') + '</td></tr>';
      return;
    }
    
    data.items.forEach(item => {
      const isPos = item.amount >= 0;
      const deltaClass = isPos ? 'text-emerald' : 'text-rose';
      const sign = isPos ? '+' : '';
      
      let i18nCat = '';
      if (item.category === 'signup_bonus' || item.category === 'topup' || item.category === 'gift_redeem') i18nCat = t('billing.category.topup');
      else if (item.category === 'compute_cost') i18nCat = t('billing.category.compute_cost');
      else if (item.category === 'gas_earned' || item.category === 'referral_reward') i18nCat = t('billing.category.gas_earned');
      
      let i18nTitle = item.title;
      if (item.category === 'signup_bonus') i18nTitle = t('billing.title.signup_bonus');
      else if (item.category === 'referral_reward') i18nTitle = t('billing.title.referral_reward');
      else if (item.category === 'gift_redeem') i18nTitle = t('billing.title.gift_redeem');
      
      const tr = document.createElement('tr');
      tr.className = 'billing-row';
      tr.innerHTML = `
        <td class="col-desc">
          <div class="billing-desc-row1">${i18nTitle}</div>
          <div class="billing-desc-row2" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">${item.detail || ''}</div>
        </td>
        <td class="col-category">
          <span class="models-status models-status-published" style="white-space: nowrap;">
            <span class="models-status-dot"></span>${i18nCat}
          </span>
        </td>
        <td class="col-time">
          <span class="billing-time">${item.created_at.substring(0, 16)}</span>
        </td>
        <td class="col-delta" style="text-align: right;">
          <div class="billing-delta-val ${deltaClass}">${sign}${item.amount} ⚡</div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  window.loadBillingLedger = async function(category = 'all', page = 1) {
    const tbody = document.getElementById('billing-tbody');
    if (!tbody) return;
    
    const cacheKey = category + '_' + page;
    
    if (!window.ledgerCache[cacheKey]) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; font-size: 0.85rem; color: var(--text-secondary); padding: 2.5rem 0;">' + t('dag.processing') + '</td></tr>';
    } else {
      renderLedger(window.ledgerCache[cacheKey]);
    }
    
    try {
      const res = await fetch('/api/user/ledger?category=' + category + '&page=' + page);
      if (!res.ok) throw new Error('Failed to load ledger');
      const data = await res.json();
      
      window.ledgerCache[cacheKey] = data;
      renderLedger(data);
    } catch (e) {
      if (!window.ledgerCache[cacheKey]) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; font-size: 0.85rem; color: var(--error-color); padding: 2.5rem 0;">Error loading data</td></tr>';
      }
    }
  };

  window.showInviteBubble = function(btn, e) {
    e.stopPropagation();
    const existing = document.querySelector('.invite-copy-bubble');
    if (existing) existing.remove();

    const bubble = document.createElement('div');
    bubble.className = 'invite-copy-bubble';
    bubble.addEventListener('click', (ev) => ev.stopPropagation());

    const wrapper = document.createElement('div');
    wrapper.className = 'invite-copy-input-wrapper';

    const input = document.createElement('input');
    input.className = 'invite-copy-input';
    const refCode = window.currentUser?.referral_code || 'demo_invite';
    const originalUrl = window.location.origin + '/register.html?ref=' + refCode;
    input.value = originalUrl;
    input.readOnly = true;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'invite-copy-icon-btn';
    const originalIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const copiedIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    copyBtn.innerHTML = originalIcon;
    
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(originalUrl).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = copiedIcon;
        input.style.color = '#10b981';
        input.style.transition = 'color 0.2s';
        const isEn = window.i18n && window.i18n.getLocale() === 'en';
        input.value = isEn ? '✨ Copied to clipboard' : '✨ 已复制到剪贴板';
        
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = originalIcon;
          input.style.color = '';
          input.value = originalUrl;
          input.select();
        }, 2000);
      });
    });

    wrapper.appendChild(input);
    wrapper.appendChild(copyBtn);
    bubble.appendChild(wrapper);
    btn.appendChild(bubble);

    const outsideClick = () => {
      bubble.style.opacity = '0';
      bubble.style.transition = 'opacity 0.2s';
      setTimeout(() => bubble.remove(), 200);
      document.removeEventListener('click', outsideClick);
    };
    setTimeout(() => document.addEventListener('click', outsideClick), 0);

    input.select();
  };

  document.addEventListener('click', () => {
    const existing = document.querySelector('.invite-copy-bubble');
    if (existing) existing.remove();
  });

  // Theme & Lang
  const savedTheme = localStorage.getItem('nanomesh-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('nanomesh-theme', newTheme);
  });

  document.getElementById('lang-toggle')?.addEventListener('click', () => {
    setLocale(getLocale() === 'zh' ? 'en' : 'zh');
    if (typeof updateLocalInferenceToggleUI === 'function') updateLocalInferenceToggleUI();
    if (window.cachedOAuthBindings) {
      setupBindButton('github', window.cachedOAuthBindings);
      setupBindButton('google', window.cachedOAuthBindings);
    }
    if (window.refreshPasskeys) window.refreshPasskeys();
    if (window.fetchNotifications) window.fetchNotifications();
    if (window.loadMessagesTab && document.getElementById('settings-tab-messages')?.classList.contains('active')) {
      window.loadMessagesTab();
    }
  });

  window.addEventListener('nanomesh-locale-changed', () => {
    if (typeof window.refreshPasskeys === 'function') {
      window.refreshPasskeys();
    }
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    if (typeof updateEstimation === 'function') {
      updateEstimation();
    }
    if (typeof updateRerouteButtonState === 'function') {
      updateRerouteButtonState();
    }
    const macroLabel = document.getElementById('macro-label') || document.querySelector('.macro-label');
    if (macroLabel) {
      const lockIcon = document.getElementById('macro-lock-icon');
      const isSnapshot = lockIcon && lockIcon.style.display !== 'none';
      macroLabel.textContent = isSnapshot ? (isEn ? 'Snapshot:' : '快照:') : (isEn ? 'Route:' : '当前路由:');
    }
    const routeChain = document.getElementById('macro-route-chain');
    const nodesForChain = (typeof activeDagNodes !== 'undefined' && activeDagNodes && activeDagNodes.length > 0)
      ? activeDagNodes
      : window.lastDagNodesToRender;
    if (routeChain && nodesForChain && nodesForChain.length > 0) {
      routeChain.textContent = nodesForChain.map(n => getCompactRoleName(n.role_id, n.name_zh, n.name_en)).join(' ➔ ');
    }
    if (typeof renderDagNodesWithAnchors === 'function' && window.lastDagNodesToRender) {
      renderDagNodesWithAnchors(window.lastDagNodesToRender, window.lastDagOptions || {});
    }
  });

  // Fetch Me
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      user = await res.json();
      
      const oldPasswordInput = document.getElementById('settings-old-password');
      if (oldPasswordInput) {
        const group = oldPasswordInput.closest('.form-group');
        if (group) {
          group.style.display = user.has_password ? 'block' : 'none';
        }
      }
      
      // Top header avatar
      if (user.avatar_url) {
        document.getElementById('user-avatar').innerHTML = `<img src="${user.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
      } else {
        document.getElementById('user-avatar').textContent = user.username.charAt(0).toUpperCase();
      }
      
      // Dropdown menu state
      document.getElementById('user-menu-guest').style.display = 'none';
      document.getElementById('user-menu-auth').style.display = 'block';
      
      // Identity
      if (user.avatar_url) {
        document.getElementById('dropdown-avatar-img').src = user.avatar_url;
        document.getElementById('dropdown-avatar-img').style.display = 'block';
        document.getElementById('dropdown-avatar-text').style.display = 'none';
      } else {
        document.getElementById('dropdown-avatar-img').style.display = 'none';
        document.getElementById('dropdown-avatar-text').textContent = user.username.charAt(0).toUpperCase();
        document.getElementById('dropdown-avatar-text').style.display = 'flex';
      }
      
      document.getElementById('dropdown-username').textContent = user.username;
      document.getElementById('dropdown-email').textContent = user.email;

      // Settings Modal population
      const settingsUsernameInput = document.getElementById('settings-username-input');
      const settingsUsernameDisplay = document.getElementById('settings-username-display');
      const settingsEmailDisplay = document.getElementById('settings-email-display');
      const settingsAvatarPreview = document.getElementById('settings-avatar-preview');
      
      if (settingsUsernameInput) settingsUsernameInput.value = user.username;
      if (settingsUsernameDisplay) settingsUsernameDisplay.textContent = user.username;
      if (settingsEmailDisplay) settingsEmailDisplay.textContent = user.email;
      
      if (settingsAvatarPreview && user.avatar_url) {
        settingsAvatarPreview.src = user.avatar_url;
      } else if (settingsAvatarPreview) {
        // Fallback transparent or default
        settingsAvatarPreview.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect fill="rgba(0,0,0,0.1)" width="72" height="72"/><text x="50%" y="50%" font-size="24" text-anchor="middle" dy=".3em" fill="%23fff">' + user.username.charAt(0).toUpperCase() + '</text></svg>';
      }

      const avatarBtn = document.getElementById('avatar-upload-btn');
      if (avatarBtn && user.avatar_updated_at) {
        const lastUpdate = new Date(user.avatar_updated_at.replace(' ', 'T') + 'Z').getTime();
        if (Date.now() - lastUpdate < 24 * 60 * 60 * 1000) {
          avatarBtn.style.opacity = '0.5';
          avatarBtn.style.pointerEvents = 'none';
          avatarBtn.title = t('error.avatarCooldown');
        } else {
          avatarBtn.style.opacity = '1';
          avatarBtn.style.pointerEvents = 'auto';
          avatarBtn.title = '';
        }
      }
      
      // Quota
      window.currentUser = user;
      document.getElementById('dropdown-points').textContent = (user.credits || 0);
      const settingsPoints = document.getElementById('settings-points-display');
      if (settingsPoints) settingsPoints.textContent = (user.credits || 0);
      
      const frozenDisplay = document.querySelector('.billing-hero-metric .billing-metric-value.text-muted');
      if (frozenDisplay) frozenDisplay.textContent = (user.frozen_credits || 0) + ' ⚡';
      
      // Credits pill on header
      const creditsDisplay = document.getElementById('credits-display');
      if (creditsDisplay) creditsDisplay.textContent = user.credits || 0;

      // Fetch bindings
      await window.refreshOAuthBindings();
      if (window.refreshPasskeys) {
        window.refreshPasskeys();
      }

      // Restore persistent chat history from cloud D1
      if (typeof fetchCloudHistory === 'function') {
        fetchCloudHistory();
      }
      
    } else {
      document.getElementById('user-menu-auth').style.display = 'none';
      document.getElementById('user-menu-guest').style.display = 'block';
      
      document.getElementById('login-btn-guest').addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = '/login.html';
      });
    }

  } catch (err) {
    console.error('Auth error', err);
  }

  // User Menu
  const menuBtn = document.getElementById('user-menu-btn');
  const menu = document.getElementById('user-menu');
  menuBtn.addEventListener('click', () => {
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!menuBtn.contains(e.target)) menu.style.display = 'none';
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  async function executeDeleteAccount() {
    const res = await fetch('/api/user/delete', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'error.hasFrozenCredits') {
        window.showModal(
          getLocale() === 'zh' ? '注销受阻' : 'Deletion Blocked',
          t(data.error),
          t('common.gotIt'),
          () => window.hideModal()
        );
      } else {
        localToast(t(data.error || 'error.networkError'));
      }
    } else {
      window.location.href = '/login.html';
    }
  }

  function showDeleteAccountWarning() {
    const html = `
      <div style="text-align: left; color: var(--text-secondary); font-size: 0.95rem; line-height: 1.6; margin-bottom: 1.5rem;">
        <ul style="padding-left: 1.5rem; margin: 0; display: flex; flex-direction: column; gap: 0.75rem;">
          <li>${t('deleteAccount.warn1')}</li>
          <li>${t('deleteAccount.warn2')}</li>
          <li>${t('deleteAccount.warn3')}</li>
          <li>${t('deleteAccount.warn4')}</li>
        </ul>
      </div>
    `;
    window.showModal(
      t('deleteAccount.title'),
      html,
      t('deleteAccount.confirm'),
      () => {
        window.hideModal();
        executeDeleteAccount();
      }
    );
  }

  document.getElementById('delete-account-btn')?.addEventListener('click', showDeleteAccountWarning);
  document.getElementById('delete-account-modal-btn')?.addEventListener('click', showDeleteAccountWarning);

  // ==========================================
  // Zero Balance Guard & Client Shift-Left Engine
  // ==========================================

  window.showZeroBalanceModal = function() {
    const existing = document.getElementById('zero-balance-modal');
    if (existing) existing.remove();

    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    const overlay = document.createElement('div');
    overlay.id = 'zero-balance-modal';
    overlay.className = 'zero-balance-overlay';
    overlay.innerHTML = `
      <div class="zero-balance-card">
        <div class="zero-balance-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
        </div>
        <div class="zero-balance-title">${isEn ? 'Insufficient Quota' : '算力余额不足'}</div>
        <div class="zero-balance-desc">
          ${isEn 
            ? 'Your current balance is 0 ⚡. You cannot upload files or submit new tasks. Please top up or redeem a gift code.' 
            : '当前可用积分余额为 0 ⚡，无法上传附件或提交模型任务。请先充值额度或兑换卡密后再试。'}
        </div>
        <div class="zero-balance-actions">
          <button class="btn btn-outline" id="btn-zero-close">${isEn ? 'Cancel' : '取消'}</button>
          <button class="btn btn-primary glow" id="btn-zero-recharge" style="background:linear-gradient(135deg, #f59e0b, #d97706); border-color:#d97706;">${isEn ? 'Top Up Now ⚡' : '立即充值 ⚡'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btn-zero-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#btn-zero-recharge').addEventListener('click', () => {
      overlay.remove();
      if (window.openSettingsModal) {
        window.openSettingsModal('billing');
      }
    });
  };

  // ==========================================
  // Rate Limit Modal (Demo Environment Protection)
  // ==========================================
  window.showRateLimitModal = function(retryAfterSeconds = 5, customMessage = '') {
    const existing = document.getElementById('rate-limit-modal');
    if (existing) {
      if (existing._countdownTimer) clearInterval(existing._countdownTimer);
      existing.remove();
    }

    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    const totalDuration = Math.max(1, parseInt(retryAfterSeconds, 10) || 5);
    let remaining = totalDuration;

    const overlay = document.createElement('div');
    overlay.id = 'rate-limit-modal';
    overlay.className = 'rate-limit-overlay';
    overlay.innerHTML = `
      <div class="rate-limit-card">
        <div class="rate-limit-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        </div>
        <div class="rate-limit-title">
          <span>⏱️</span>
          <span>${isEn ? 'Request Rate Limited · Demo Protection' : '请求过于频繁 · Demo 环境保护'}</span>
        </div>
        <div class="rate-limit-desc">
          ${isEn 
            ? 'NanoMesh is currently deployed on Cloudflare Workers Free Tier. To preserve community quota and prevent accidental burst abuse, a gentle cooldown is active.' 
            : '当前系统运行在 Cloudflare Workers 免费配额环境中。为保障所有体验者平稳使用并防止额度耗尽，系统启用了温和的频控保护机制。'}
        </div>
        <div class="rate-limit-timer-box">
          <div class="rate-limit-timer-number" id="rate-limit-counter">${remaining}s</div>
          <div class="rate-limit-progress-bar-bg">
            <div class="rate-limit-progress-bar-fill" id="rate-limit-progress" style="width: 100%;"></div>
          </div>
          <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 4px;">
            ${isEn ? 'Cooling down, ready soon...' : '正在冷却，倒计时结束后可继续提问...'}
          </div>
        </div>
        <div class="rate-limit-actions">
          <button class="btn btn-outline" id="btn-rate-limit-close" style="border-radius: 8px;">
            ${isEn ? 'Dismiss' : '稍后重试'}
          </button>
          <button class="btn btn-primary" id="btn-rate-limit-action" style="min-width: 140px; border-radius: 8px;">
            ${isEn ? 'Wait' : '请稍候'} (${remaining}s)
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const counterEl = overlay.querySelector('#rate-limit-counter');
    const progressEl = overlay.querySelector('#rate-limit-progress');
    const actionBtn = overlay.querySelector('#btn-rate-limit-action');
    const closeBtn = overlay.querySelector('#btn-rate-limit-close');

    const closeModal = () => {
      if (overlay._countdownTimer) clearInterval(overlay._countdownTimer);
      overlay.remove();
      const inputEl = document.getElementById('chat-input');
      if (inputEl) inputEl.focus();
    };

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (actionBtn) actionBtn.addEventListener('click', closeModal);

    overlay._countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(overlay._countdownTimer);
        overlay._countdownTimer = null;
        if (counterEl) counterEl.textContent = isEn ? 'Ready!' : '准备就绪!';
        if (progressEl) progressEl.style.width = '0%';
        if (actionBtn) {
          actionBtn.textContent = isEn ? 'Continue / Dismiss ➔' : '立即继续提问 ➔';
          actionBtn.style.background = 'var(--accent-primary, #00c9db)';
          actionBtn.style.color = '#000';
          actionBtn.style.fontWeight = '600';
        }
      } else {
        if (counterEl) counterEl.textContent = `${remaining}s`;
        if (progressEl) {
          const pct = Math.max(0, (remaining / totalDuration) * 100);
          progressEl.style.width = `${pct}%`;
        }
        if (actionBtn) {
          actionBtn.textContent = `${isEn ? 'Wait' : '请稍候'} (${remaining}s)`;
        }
      }
    }, 1000);
  };

  // Helper: Canvas Downsampling for Images (Max 2048px, JPEG 0.85)
  function downsampleImage(file, maxDimension = 2048) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            resolve(blob || file);
          }, 'image/jpeg', 0.85);
        };
        img.onerror = () => resolve(file);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(file);
      reader.readAsDataURL(file);
    });
  }

  // Helper: Parse CSV to Markdown table
  function parseCsvToMarkdown(csvText) {
    const lines = csvText.trim().split(/\r?\n/).slice(0, 100);
    if (!lines.length) return '';
    const rows = lines.map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    let md = '| ' + rows[0].join(' | ') + ' |\n';
    md += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n';
    for (let i = 1; i < rows.length; i++) {
      md += '| ' + rows[i].join(' | ') + ' |\n';
    }
    return md;
  }

  // Mozilla PDF.js Shift-Left Loader & Parser (Client-side 0-server-cost extraction)
  let pdfjsLibPromise = null;
  async function getPdfJsLib() {
    if (window.pdfjsLib) {
      if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
      return window.pdfjsLib;
    }
    if (pdfjsLibPromise) return pdfjsLibPromise;

    pdfjsLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        } else {
          reject(new Error('PDF.js failed to initialize'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load PDF.js from CDN'));
      document.head.appendChild(script);
    });

    return pdfjsLibPromise;
  }

  async function parsePdfShiftLeft(file) {
    const pdfjs = await getPdfJsLib();
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;

    const pageTexts = [];
    const maxPagesToRead = Math.min(numPages, 40);

    for (let pageNum = 1; pageNum <= maxPagesToRead; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const str = textContent.items.map(it => it.str || '').filter(Boolean).join(' ').trim();
        if (str) {
          pageTexts.push(`--- [ 第 ${pageNum} 页 / Page ${pageNum} ] ---\n${str}`);
        }
      } catch (pageErr) {
        console.warn(`Error reading PDF page ${pageNum}:`, pageErr);
      }
    }

    const fullText = pageTexts.join('\n\n').trim();

    // If extractable text was found (digital text PDF)
    if (fullText.length >= 40) {
      return {
        isScanned: false,
        text: fullText,
        pageCount: numPages
      };
    }

    // Scanned / Image-only PDF: render first 3 pages to JPEG images for Vision VLM OCR
    const scannedImages = [];
    const maxScanPages = Math.min(numPages, 3);

    for (let pageNum = 1; pageNum <= maxScanPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
        if (blob) {
          const imgFile = new File([blob], `${file.name.replace(/\.pdf$/i, '')}_p${pageNum}.jpg`, { type: 'image/jpeg' });
          scannedImages.push(imgFile);
        }
      } catch (renderErr) {
        console.warn(`Error rendering scanned PDF page ${pageNum}:`, renderErr);
      }
    }

    return {
      isScanned: true,
      images: scannedImages,
      pageCount: numPages
    };
  }

  // File Upload Logic with Pre-flight Quota Gatekeeper & Pipelined Uploading
  // File Upload Logic with Pre-flight Quota Gatekeeper & Pipelined Uploading
  const inputs = ['upload-image', 'upload-audio', 'upload-text'];
  inputs.forEach(id => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      e.target.value = '';
      processUploadedFiles(files);
    });
  });

  // Global Drag & Drop Handler
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processUploadedFiles(Array.from(e.dataTransfer.files));
    }
  });

  // Global Clipboard Paste Handler
  document.addEventListener('paste', (e) => {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
      processUploadedFiles(Array.from(e.clipboardData.files));
    }
  });

  async function processUploadedFiles(newFiles) {
    if (!newFiles || newFiles.length === 0) return;

    if (!user) {
      window.showModal(t('chat.loginRequired'), t('chat.loginToUse'), t('auth.goToLogin'), () => { window.location.href = '/login.html'; });
      return;
    }

    // Pre-flight check: If local cached balance is 0, block immediately
    if (user.credits <= 0) {
      window.showZeroBalanceModal();
      return;
    }

    if (selectedFiles.length + newFiles.length > MAX_FILES) {
      localToast(t('error.maxFiles', { n: MAX_FILES }));
      return;
    }

    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';

    for (const file of newFiles) {
      let modality = 'text_doc';
      if (file.type.startsWith('image/')) modality = 'image';
      else if (file.type.startsWith('audio/')) modality = 'audio';

      // 1. Shift-left pre-processing (Browser memory text/image normalization)
      let processedBlob = file;
      let inMemoryText = null;

      if (modality === 'image') {
        processedBlob = await downsampleImage(file);
      } else if (modality === 'audio') {
        const audioUrl = URL.createObjectURL(file);
        const tempAudio = new Audio(audioUrl);
        tempAudio.onloadedmetadata = () => {
          if (tempAudio.duration > 600) {
            localToast('音频时长超过 10 分钟，模型推理时可能会自动截断。', 'info');
          }
          URL.revokeObjectURL(audioUrl);
        };
      } else {
        // Document / Text / PDF
        const fileNameLower = (file.name || '').toLowerCase();
        if (fileNameLower.endsWith('.pdf') || file.type === 'application/pdf') {
          try {
            localToast(isEn ? 'Extracting PDF content (Shift-Left)...' : '正在解析 PDF 文档 (Shift-Left)...', 'info');
            const pdfRes = await parsePdfShiftLeft(file);
            if (pdfRes && !pdfRes.isScanned && pdfRes.text) {
              modality = 'text';
              inMemoryText = pdfRes.text;
              localToast(isEn ? `PDF extracted successfully (${pdfRes.pageCount} pages)` : `已成功提取 PDF 文本 (${pdfRes.pageCount} 页)，就绪`, 'success');
            } else if (pdfRes && pdfRes.isScanned && pdfRes.images.length > 0) {
              localToast(isEn ? 'Scanned PDF detected. Converted to images for OCR.' : '检测到影印扫描版 PDF，已自动将页面转为图像进行视觉 OCR 解析', 'info');
              await processUploadedFiles(pdfRes.images);
              continue;
            }
          } catch (pdfErr) {
            console.error('PDF parsing error:', pdfErr);
            localToast(isEn ? 'PDF parse failed, falling back to raw upload' : 'PDF 解析失败，降级为原始上传', 'warning');
          }
        } else if (fileNameLower.endsWith('.csv')) {
          const rawText = await file.text();
          inMemoryText = parseCsvToMarkdown(rawText);
          modality = 'text';
        } else if (fileNameLower.endsWith('.txt') || fileNameLower.endsWith('.md') || fileNameLower.endsWith('.json')) {
          inMemoryText = await file.text();
          modality = 'text';
        }

        if (inMemoryText && inMemoryText.length > 30000) {
          inMemoryText = inMemoryText.slice(0, 30000) + '\n\n[...内容过长，已就地截取前 30,000 字符...]';
          localToast('文本总长超出 30,000 字软限制，已自动就地截断。', 'info');
        }
      }

      // 2. Pre-sign request with server quota validation
      let previewUrl = null;
      if (modality === 'image' || (file.type && file.type.startsWith('image/'))) {
        try {
          previewUrl = URL.createObjectURL(processedBlob || file);
        } catch (e) {}
      }

      const fileDesc = {
        name: file.name,
        size: processedBlob.size || file.size,
        type: file.type,
        modality,
        previewUrl,
        assetId: crypto.randomUUID(),
        r2Key: null,
        inMemoryText,
        rawFile: processedBlob || file,
        uploadStatus: inMemoryText ? 'ready' : 'uploading'
      };

      selectedFiles.push(fileDesc);
      renderFileChips();

      // If already parsed text, no remote upload needed
      if (inMemoryText) {
        fileDesc.uploadStatus = 'ready';
        renderFileChips();
        continue;
      }

      try {
        const uploadBlob = processedBlob || file;
        const isLargeFile = uploadBlob.size > 25 * 1024 * 1024;

        if (isLargeFile) {
          // Tier B: Presigned S3 direct upload for large files (> 25MB)
          const presignRes = await fetch('/api/upload/presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file_name: file.name,
              file_size: uploadBlob.size,
              mime_type: file.type || 'application/octet-stream',
              modality
            })
          });

          if (presignRes.status === 403) {
            selectedFiles = selectedFiles.filter(f => f.assetId !== fileDesc.assetId);
            renderFileChips();
            window.showZeroBalanceModal();
            return;
          }

          if (!presignRes.ok) throw new Error('Presign failed');
          const presignData = await presignRes.json();
          fileDesc.r2Key = presignData.r2Key;
          fileDesc.assetId = presignData.assetId;

          const putRes = await fetch(presignData.uploadUrl, {
            method: 'PUT',
            body: uploadBlob,
            headers: { 'Content-Type': file.type || 'application/octet-stream' }
          });

          if (!putRes.ok) {
            throw new Error(`S3 direct upload failed with status ${putRes.status}`);
          }
        } else {
          // Tier A: Native same-origin direct upload (<= 25MB)
          const formData = new FormData();
          formData.append('file', uploadBlob, file.name);
          formData.append('modality', modality);

          const uploadRes = await fetch('/api/upload/file', {
            method: 'POST',
            body: formData
          });

          if (uploadRes.status === 403) {
            selectedFiles = selectedFiles.filter(f => f.assetId !== fileDesc.assetId);
            renderFileChips();
            window.showZeroBalanceModal();
            return;
          }

          if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            throw new Error('Upload failed: ' + errText);
          }

          const uploadData = await uploadRes.json();
          fileDesc.r2Key = uploadData.r2Key;
          fileDesc.assetId = uploadData.assetId;
        }

        fileDesc.uploadStatus = 'ready';
        renderFileChips();
      } catch (uploadErr) {
        console.error('File upload error:', uploadErr);
        fileDesc.uploadStatus = 'error';
        renderFileChips();
        localToast(uploadErr.message || '附件存储失败，请重试', 'error');
      }
    }
  }

  function renderFileChips() {
    const container = document.getElementById('attachments-preview');
    if (!container) return;
    container.innerHTML = '';
    updateEstimation();
    
    if (selectedFiles.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';
    
    selectedFiles.forEach((file, index) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      const isReady = file.uploadStatus === 'ready';
      const isError = file.uploadStatus === 'error';
      const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';

      let statusBadge = '';
      if (isReady) {
        statusBadge = `<span class="local-parse-badge success-flash">${isEn ? '✓ Ready' : '✓ 已就绪'}</span>`;
      } else if (isError) {
        statusBadge = `<span class="local-parse-badge" style="background:rgba(239,68,68,0.15);color:#ef4444;">${isEn ? '⚠ Failed' : '⚠ 上传失败'}</span>`;
      } else {
        statusBadge = `<span class="local-parse-badge">${isEn ? '⏳ Uploading...' : '⏳ 存储中...'}</span>`;
      }

      chip.innerHTML = `
        ${statusBadge}
        <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8rem;color:var(--text-primary);font-weight:500;">
          ${escapeHtml(file.name)}
        </span>
        <svg class="file-chip-close" data-index="${index}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;margin-left:4px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      `;
      container.appendChild(chip);
    });

    document.querySelectorAll('.file-chip-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.closest('.file-chip-close').getAttribute('data-index'));
        selectedFiles.splice(idx, 1);
        renderFileChips();
      });
    });
  }

  // ==========================================
  // Interactive DAG Workstation & Chat Orchestration Engine
  // ==========================================

  window.chatSessionId = window.chatSessionId || crypto.randomUUID();
  window.chatRoundIndex = window.chatRoundIndex || 0;
  window.lastRoundSummary = window.lastRoundSummary || '';
  window.currentDagBaseSummary = window.currentDagBaseSummary || '';
  window.lastHadMedia = false;
  window.sessionAssets = window.sessionAssets || [];
  window.sessionBranches = window.sessionBranches || { 'main': { branchId: 'main', isMediaBranch: false, lastValidSummary: '', assetIds: [] } };
  window.activeBranchId = window.activeBranchId || 'main';
  window._currentPreFlightSnapshot = null;
  window._currentStagedNewFiles = [];
  window.currentRunningTemplateId = window.currentRunningTemplateId || null;
  window.activeChatAbortController = null;
  let activeDagNodes = [];
  let currentCandidateTemplates = [];
  let currentActiveAssistantId = null;
  let currentActiveRunId = null;

  // Console Back Button & Workflow State Management
  let isWorkflowExecuting = false;
  function setWorkflowExecutionLocked(isLocked) {
    isWorkflowExecuting = !!isLocked;
    const macroCapsuleBtn = document.getElementById('macro-capsule-btn');
    const macroDropdown = document.getElementById('macro-dropdown');
    const nodesContainer = document.getElementById('dag-nodes-container');
    const rerouteBtn = document.getElementById('macro-reroute-btn');
    const nodeInspector = document.getElementById('node-inspector-popover');
    const sendBtn = document.getElementById('send-btn');
    const chatInput = document.getElementById('chat-input');
    const inputArea = document.getElementById('input-area');
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';

    if (isLocked) {
      if (macroCapsuleBtn) {
        macroCapsuleBtn.classList.add('is-locked');
        macroCapsuleBtn.setAttribute('title', isEn ? 'Workflow executing, route locked' : '工作流执行中，暂不可修改路线');
      }
      if (macroDropdown) macroDropdown.style.display = 'none';
      if (nodesContainer) nodesContainer.classList.add('is-executing');
      const sinkAnchor = document.getElementById('dag-sink-anchor');
      if (sinkAnchor) {
        sinkAnchor.classList.add('is-executing');
        sinkAnchor.classList.remove('completed');
      }
      if (rerouteBtn) rerouteBtn.disabled = true;
      if (nodeInspector) nodeInspector.style.display = 'none';
      if (sendBtn) sendBtn.disabled = true;
      if (chatInput) {
        chatInput.disabled = true;
        chatInput.placeholder = isEn ? '⚡ Workflow executing, please wait...' : '⚡ 工作流执行中，请稍候...';
      }
      if (inputArea) inputArea.classList.add('is-locked-input');
      currentInspectedNodeRoleId = null;
    } else {
      if (macroCapsuleBtn) {
        macroCapsuleBtn.classList.remove('is-locked');
        macroCapsuleBtn.setAttribute('title', isEn ? 'Click to expand macro routes' : '点击展开宏观切换路线');
      }
      if (nodesContainer) nodesContainer.classList.remove('is-executing');
      const sinkAnchor = document.getElementById('dag-sink-anchor');
      if (sinkAnchor) sinkAnchor.classList.remove('is-executing');
      if (sendBtn) sendBtn.disabled = false;
      if (chatInput) {
        chatInput.disabled = false;
        chatInput.placeholder = isEn 
          ? 'Enter prompt to analyze image, audio or text...' 
          : '输入指令，分析图片，音频或文本。';
      }
      if (inputArea) inputArea.classList.remove('is-locked-input');
      if (typeof updateRerouteButtonState === 'function') updateRerouteButtonState();
    }
  }

  function triggerInputAttentionGlow() {
    const inputArea = document.getElementById('input-area');
    const input = document.getElementById('chat-input');
    if (inputArea) {
      inputArea.classList.remove('input-attention-pulse');
      void inputArea.offsetWidth; // Force DOM reflow
      inputArea.classList.add('input-attention-pulse');
      setTimeout(() => {
        inputArea.classList.remove('input-attention-pulse');
      }, 1600);
    }
    if (input) {
      input.focus();
    }
  }

  function setWorkflowActive(active) {
    const viewport = document.getElementById('workspace-viewport');
    const mobileSwitcher = document.getElementById('mobile-tab-switcher');
    if (viewport) {
      if (active) {
        viewport.classList.add('workflow-active');
        if (mobileSwitcher) {
          mobileSwitcher.classList.add('active');
          mobileSwitcher.style.display = '';
        }
        // Multi-frame measurement passes during and after workbench 500ms CSS split transition
        requestAnimationFrame(() => renderDagSvgConnectors());
        setTimeout(() => renderDagSvgConnectors(), 100);
        setTimeout(() => renderDagSvgConnectors(), 250);
        setTimeout(() => renderDagSvgConnectors(), 520);
      } else {
        viewport.classList.remove('workflow-active');
        if (mobileSwitcher) {
          mobileSwitcher.classList.remove('active');
          mobileSwitcher.style.display = 'none';
        }
      }
    }
  }

  function resetToRootInterface() {
    // 1. Abort active execution if running
    setWorkflowExecutionLocked(false);
    if (window.activeChatAbortController) {
      try { window.activeChatAbortController.abort(); } catch (err) {}
    }

    // 2. Clear conversation messages flow completely so Stage 1 root view is pristine
    const messagesFlow = document.getElementById('messages-flow');
    if (messagesFlow) {
      messagesFlow.innerHTML = '';
    }

    // 3. Clear DAG canvas nodes and SVG lines
    const nodesContainer = document.getElementById('dag-nodes-container');
    if (nodesContainer) nodesContainer.innerHTML = '';
    const svgCanvas = document.getElementById('dag-svg-canvas');
    if (svgCanvas) svgCanvas.innerHTML = '';

    // 4. Hide Unified Control Bar & dropdown
    const controlBar = document.getElementById('unified-control-bar') || document.getElementById('macro-workflow-bar');
    if (controlBar) controlBar.style.display = 'none';
    const macroDropdown = document.getElementById('macro-dropdown');
    if (macroDropdown) macroDropdown.style.display = 'none';

    // 5. Hide arbitration and telemetry pills
    const arbBar = document.getElementById('arbitration-header-bar');
    if (arbBar) arbBar.style.display = 'none';
    const intentPill = document.getElementById('intent-pill');
    if (intentPill) intentPill.style.display = 'none';
    const cacheStreamPill = document.getElementById('cache-stream-pill');
    if (cacheStreamPill) cacheStreamPill.style.display = 'none';

    // 6. Hide Node Inspector
    const inspector = document.getElementById('node-inspector-popover');
    if (inspector) inspector.style.display = 'none';
    currentInspectedNodeRoleId = null;

    // 7. Clear user inputs & file attachments
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    selectedFiles.length = 0;
    renderFileChips();
    if (typeof updateEstimation === 'function') updateEstimation();

    // 8. Cancel any active typewriter timer
    if (typewriterTimer) {
      clearInterval(typewriterTimer);
      typewriterTimer = null;
    }

    // 9. Re-enable send button
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = false;

    // 10. Reset runtime session states for a fresh round
    window.chatSessionId = crypto.randomUUID();
    window.chatRoundIndex = 0;
    window.lastRoundSummary = '';
    window.currentDagBaseSummary = '';
    window.lastHadMedia = false;
    window.sessionAssets = [];
    window.sessionBranches = { 'main': { branchId: 'main', isMediaBranch: false, lastValidSummary: '', assetIds: [] } };
    window.activeBranchId = 'main';
    window._currentPreFlightSnapshot = null;
    window._currentStagedNewFiles = [];
    window.currentRunningTemplateId = null;
    window.lastUserPrompt = '';
    currentActiveRunId = null;
    currentActiveAssistantId = null;
    activeDagNodes = [];
    currentCandidateTemplates = [];
    window.activeCustomRolePrompts = {};
    window.activeChosenRoleModels = {};
    window.originalNodeConfigs = {};

    // 11. Reset mobile tabs to default if switched
    const mobileSwitcher = document.getElementById('mobile-tab-switcher');
    if (mobileSwitcher) {
      mobileSwitcher.classList.remove('active');
      mobileSwitcher.style.display = 'none';
    }
    const tabBtnCanvas = document.getElementById('tab-btn-canvas');
    const tabBtnStream = document.getElementById('tab-btn-stream');
    const canvasPane = document.getElementById('workbench-canvas-pane');
    const streamPane = document.getElementById('stream-terminal-pane');
    if (tabBtnCanvas && tabBtnStream) {
      tabBtnCanvas.classList.add('active');
      tabBtnStream.classList.remove('active');
      canvasPane?.classList.add('tab-active');
      streamPane?.classList.remove('tab-active');
    }

    // 12. Switch viewport back to Stage 1 root interface
    setWorkflowActive(false);

    // 13. Focus input
    if (input) {
      input.focus();
    }
  }

  function initConsoleBackButton() {
    const handleBack = (e) => {
      e.stopPropagation();
      resetToRootInterface();
      triggerInputAttentionGlow();
    };
    const backBtn = document.getElementById('console-back-btn');
    if (backBtn) backBtn.addEventListener('click', handleBack);
    const mobileBackBtn = document.getElementById('mobile-back-to-home-btn');
    if (mobileBackBtn) mobileBackBtn.addEventListener('click', handleBack);
  }

  // Fixed Portal Popover Menu for History Drawer (Expands to the right)
  let currentMenuTraceId = null;

  function closeFixedTraceMenu() {
    const menu = document.getElementById('trace-menu-popover-fixed');
    if (menu) menu.style.display = 'none';
    document.querySelectorAll('.trace-actions').forEach(a => a.classList.remove('menu-open'));
    currentMenuTraceId = null;
  }

  function openFixedTraceMenu(traceId, moreBtn) {
    const menu = document.getElementById('trace-menu-popover-fixed');
    if (!menu || !moreBtn) return;

    if (currentMenuTraceId === traceId && menu.style.display !== 'none') {
      closeFixedTraceMenu();
      return;
    }

    currentMenuTraceId = traceId;
    const history = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
    const item = history.find(x => x.id === traceId);
    if (!item) return;

    const pinText = document.getElementById('trace-menu-pin-text');
    if (pinText) {
      pinText.textContent = item.pinned
        ? (typeof t === 'function' ? t('history.unpin') : '取消固定')
        : (typeof t === 'function' ? t('history.pin') : '固定此条');
    }

    document.querySelectorAll('.trace-actions').forEach(a => a.classList.remove('menu-open'));
    moreBtn.closest('.trace-actions')?.classList.add('menu-open');

    // Measure and position to the right of moreBtn into the canvas
    menu.style.display = 'flex';
    menu.style.visibility = 'hidden';

    const rect = moreBtn.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 135;
    const menuHeight = menu.offsetHeight || 120;

    let left = rect.right + 8;
    if (left + menuWidth > window.innerWidth - 10) {
      left = Math.max(10, rect.left - menuWidth - 8);
    }

    let top = rect.top - 4;
    if (top + menuHeight > window.innerHeight - 10) {
      top = window.innerHeight - menuHeight - 10;
    }
    if (top < 10) top = 10;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = 'visible';
  }

  function sanitizePromptLeakage(text) {
    if (!text) return '';
    return text.replace(
      /(?:\n+|\r\n)+(?:[#* -]*\**【?(?:铁律|输出语言|内容详略|系统守则|指令规则|全局预设|规则说明|交付铁律)】?\**[:：]?[\s\S]*)$/i,
      ''
    ).replace(
      /(?:\n+|\r\n)+[#* -]*(?:铁律|Ironclad Rule)[:：]?\s*[\s\S]*$/i,
      ''
    ).trim();
  }

  async function fetchCloudHistory() {
    try {
      const res = await fetch('/api/history');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.sessions)) {
        let localHistory = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
        const cloudSessionIds = new Set(data.sessions.map(s => s.sessionId));
        const merged = [...data.sessions];
        for (const localItem of localHistory) {
          if (localItem.sessionId && !cloudSessionIds.has(localItem.sessionId)) {
            merged.push(localItem);
            syncSaveHistoryToCloud(localItem);
          }
        }
        merged.sort((a, b) => {
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
          return (b.timestamp || 0) - (a.timestamp || 0);
        });
        localStorage.setItem('nanomesh_trace_history', JSON.stringify(merged.slice(0, 50)));
        renderHistoryList();
      }
    } catch (e) {
      console.warn('Failed to sync cloud history:', e);
    }
  }

  async function syncSaveHistoryToCloud(record) {
    if (!record || !record.sessionId) return;
    try {
      await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      });
    } catch (e) {
      console.warn('Failed to persist history to cloud:', e);
    }
  }

  async function syncHistoryItemUpdate(sessionId, patchData) {
    if (!sessionId) return;
    try {
      await fetch('/api/history/' + encodeURIComponent(sessionId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchData)
      });
    } catch (e) {
      console.warn('Failed to update history on cloud:', e);
    }
  }

  async function syncHistoryItemDelete(sessionId) {
    if (!sessionId) return;
    try {
      await fetch('/api/history/' + encodeURIComponent(sessionId), {
        method: 'DELETE'
      });
    } catch (e) {
      console.warn('Failed to delete history on cloud:', e);
    }
  }

  function initFixedTraceMenuActions() {
    const pinBtn = document.getElementById('trace-menu-pin-btn');
    pinBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const traceId = currentMenuTraceId;
      closeFixedTraceMenu();
      if (!traceId) return;
      const history = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
      const target = history.find(x => x.id === traceId);
      if (target) {
        target.pinned = !target.pinned;
        localStorage.setItem('nanomesh_trace_history', JSON.stringify(history));
        renderHistoryList();
        syncHistoryItemUpdate(target.sessionId || target.id, { pinned: target.pinned });
      }
    });

    const renameBtn = document.getElementById('trace-menu-rename-btn');
    renameBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const traceId = currentMenuTraceId;
      closeFixedTraceMenu();
      if (!traceId) return;
      const history = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
      const target = history.find(x => x.id === traceId);
      if (target) {
        const promptMsg = (typeof t === 'function' && t('history.renamePrompt')) || '重命名此条记录:';
        const newTitle = window.prompt(promptMsg, target.title || '');
        if (newTitle !== null && newTitle.trim() && newTitle.trim() !== target.title) {
          target.title = newTitle.trim();
          localStorage.setItem('nanomesh_trace_history', JSON.stringify(history));
          renderHistoryList();
          syncHistoryItemUpdate(target.sessionId || target.id, { title: target.title });
        }
      }
    });

    const deleteBtn = document.getElementById('trace-menu-delete-btn');
    deleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const traceId = currentMenuTraceId;
      closeFixedTraceMenu();
      if (!traceId) return;
      let history = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
      const itemToDelete = history.find(x => x.id === traceId);
      if (itemToDelete) {
        history = history.filter(x => x.id !== traceId);
        localStorage.setItem('nanomesh_trace_history', JSON.stringify(history));
        if (itemToDelete.sessionId === window.chatSessionId) {
          resetToRootInterface();
        }
        renderHistoryList();
        syncHistoryItemDelete(itemToDelete.sessionId || itemToDelete.id);
      }
    });
  }

  // Stage 5: Off-canvas Trace History Drawer Logic
  function initHistoryDrawer() {
    const toggleBtn = document.getElementById('history-drawer-toggle');
    const drawer = document.getElementById('history-drawer');
    const closeBtn = document.getElementById('history-drawer-close');
    const listEl = document.getElementById('history-drawer-list');
    const newChatBtn = document.getElementById('history-new-chat-btn');
    if (!toggleBtn || !drawer) return;

    if (newChatBtn) {
      newChatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetToRootInterface();
        closeHistoryDrawer();
        triggerInputAttentionGlow();
      });
    }

    // Toggle on click only (no hover timers to prevent accidental triggers)
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (drawer.classList.contains('open')) {
        closeHistoryDrawer();
      } else {
        openHistoryDrawer();
      }
    });

    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeHistoryDrawer();
    });

    // Close only when clicking anywhere outside of the drawer, toggle button, and fixed popover
    document.addEventListener('click', (e) => {
      if (drawer.classList.contains('open')) {
        if (!e.target.closest('#history-drawer') &&
            !e.target.closest('#history-drawer-toggle') &&
            !e.target.closest('#trace-menu-popover-fixed')) {
          closeHistoryDrawer();
        }
      }
      if (!e.target.closest('#trace-menu-popover-fixed') && !e.target.closest('.trace-more-btn')) {
        closeFixedTraceMenu();
      }
    });

    // Close fixed menu on drawer scroll
    listEl?.addEventListener('scroll', () => {
      closeFixedTraceMenu();
    }, { passive: true });

    initFixedTraceMenuActions();
    renderHistoryList();
    fetchCloudHistory();
  }

  function openHistoryDrawer() {
    const drawer = document.getElementById('history-drawer');
    if (drawer) {
      drawer.classList.add('open');
      renderHistoryList();
      fetchCloudHistory();
    }
  }

  function closeHistoryDrawer() {
    const drawer = document.getElementById('history-drawer');
    if (drawer) {
      drawer.classList.remove('open');
      closeFixedTraceMenu();
    }
  }

  function saveTraceToHistory(record) {
    try {
      let history = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
      const sessId = record.sessionId || window.chatSessionId || ('session-' + Date.now());
      let existingIndex = history.findIndex(x => (x.sessionId && x.sessionId === sessId) || x.id === record.id);

      let targetRecord;
      if (existingIndex >= 0) {
        targetRecord = history[existingIndex];
        history.splice(existingIndex, 1);
        targetRecord.title = record.title || targetRecord.title;
        targetRecord.cost = record.cost || targetRecord.cost;
        targetRecord.duration = record.duration || targetRecord.duration;
        targetRecord.nodesCount = record.nodesCount || targetRecord.nodesCount;
        targetRecord.cached = record.cached !== undefined ? record.cached : targetRecord.cached;
        targetRecord.timestamp = Date.now();
        if (!targetRecord.rounds) targetRecord.rounds = [];
        if (record.round) {
          const rIdx = targetRecord.rounds.findIndex(r => r.runId && r.runId === record.round.runId);
          if (rIdx >= 0) {
            targetRecord.rounds[rIdx] = record.round;
          } else {
            targetRecord.rounds.push(record.round);
          }
        }
      } else {
        targetRecord = {
          id: record.id || ('trace-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
          sessionId: sessId,
          title: record.title || '多模态任务编排',
          cost: record.cost || '120',
          duration: record.duration || '2.8s',
          nodesCount: record.nodesCount || 1,
          cached: record.cached || false,
          pinned: record.pinned || false,
          timestamp: Date.now(),
          rounds: record.round ? [record.round] : []
        };
      }

      history.unshift(targetRecord);

      // Sort pinned first, then timestamp descending
      history.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });

      // Maintain up to 50 conversations in history
      localStorage.setItem('nanomesh_trace_history', JSON.stringify(history.slice(0, 50)));
      renderHistoryList();
      syncSaveHistoryToCloud(targetRecord);
    } catch (e) {
      console.warn('Failed to save trace to history:', e);
    }
  }

  function restoreConversationFromHistory(record) {
    if (!record) return;

    // 1. Abort any currently running chat stream
    if (window.activeChatAbortController) {
      try { window.activeChatAbortController.abort(); } catch (e) {}
    }

    // 2. Close drawer
    closeHistoryDrawer();

    // 3. Switch to workbench split view
    setWorkflowActive(true);

    // 4. Reveal Unified Control Bar
    const controlBar = document.getElementById('unified-control-bar') || document.getElementById('macro-workflow-bar');
    if (controlBar) controlBar.style.display = 'inline-flex';

    // 5. Empty messages flow
    const messagesFlow = document.getElementById('messages-flow');
    if (!messagesFlow) return;
    messagesFlow.innerHTML = '';

    // 6. User avatar
    const u = window.currentUser;
    let userAvatarHtml = '<span class="msg-avatar-initial">U</span>';
    if (u && u.avatar_url) {
      userAvatarHtml = `<img src="${escapeHtml(u.avatar_url)}" class="msg-avatar-img" alt="User">`;
    } else if (u && u.username) {
      userAvatarHtml = `<span class="msg-avatar-initial">${escapeHtml(u.username.charAt(0).toUpperCase())}</span>`;
    }

    // 7. Extract rounds (synthesize for legacy entries if needed)
    const rounds = (record.rounds && record.rounds.length > 0) ? record.rounds : [{
      runId: 'legacy-' + (record.id || Date.now()),
      userPrompt: record.title || '历史会话',
      assistantOutput: record.assistantOutput || '【历史归档记录】此记录创建于历史快照中，仅保留了路由摘要。',
      nodes: record.nodes || [],
      cost: record.cost,
      duration: record.duration,
      cached: record.cached,
      timestamp: record.timestamp || Date.now()
    }];

    // 8. Render each round into messages-flow
    rounds.forEach(rnd => {
      const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
      // 8a. User row
      const userRow = document.createElement('div');
      userRow.className = 'chat-msg-row user';
      userRow.id = 'user-row-' + rnd.runId;

      let attachmentsHtml = '';
      if (rnd.assets && rnd.assets.length > 0) {
        attachmentsHtml = '<div class="user-attachments-grid">' + 
          rnd.assets.map(f => {
            const sizeStr = formatFileSize(f.size);
            const isImg = (f.previewUrl && !f.previewUrl.startsWith('blob:')) || (f.type && f.type.startsWith('image/')) || f.modality === 'image';
            const imgUrl = (f.previewUrl && !f.previewUrl.startsWith('blob:')) ? f.previewUrl : (f.r2Key ? `/api/asset?key=${encodeURIComponent(f.r2Key)}` : '');
            if (isImg && imgUrl) {
              return `
                <div class="user-asset-card" title="${escapeHtml(f.name)} (${sizeStr})" onclick="window.open('${escapeHtml(imgUrl)}', '_blank')" style="cursor:pointer;">
                  <div class="user-asset-thumb-box">
                    <img src="${escapeHtml(imgUrl)}" class="user-asset-thumb-img" alt="${escapeHtml(f.name)}" />
                  </div>
                  <div class="user-asset-meta-col">
                    <span class="user-asset-filename">${escapeHtml(f.name)}</span>
                    <span class="user-asset-filesize">${sizeStr}</span>
                  </div>
                </div>
              `;
            } else {
              const isPdf = (f.name || '').toLowerCase().endsWith('.pdf') || f.modality === 'pdf';
              const docIcon = isPdf ? '📄' : f.modality === 'audio' ? '🎙️' : '📎';
              return `
                <div class="user-asset-card" title="${escapeHtml(f.name)} (${sizeStr})">
                  <div class="user-asset-thumb-box is-doc">
                    <span class="user-asset-doc-icon">${docIcon}</span>
                  </div>
                  <div class="user-asset-meta-col">
                    <span class="user-asset-filename">${escapeHtml(f.name)}</span>
                    <span class="user-asset-filesize">${sizeStr}</span>
                  </div>
                </div>
              `;
            }
          }).join('') +
          '</div>';
      }

      let intentPillHtml = '';
      if (rnd.intentState) {
        const compactIntent = getCompactIntentName(rnd.intentState, isEn);
        const stateClass = rnd.intentState === 'ANCHOR_TAIL' ? 'state-a' :
          rnd.intentState === 'REBIND_ROOT' ? 'state-b' :
          rnd.intentState === 'CROSS_FUSION' ? 'state-d' :
          rnd.intentState === 'SWITCH_BRANCH' ? 'state-e' : 'state-c';
        const titleText = isEn 
          ? (rnd.intentState === 'ANCHOR_TAIL' ? 'State A: Stripped raw media, inheriting prior turn text context' :
             rnd.intentState === 'REBIND_ROOT' ? 'State B: Reset asset pointer, re-exploring raw media assets' :
             rnd.intentState === 'CROSS_FUSION' ? 'State D: Cross-turn asset fusion and comparison' :
             rnd.intentState === 'SWITCH_BRANCH' ? 'State E: Switched context to recalled historical task branch' :
             'State C: Detached historical context, independent clean orchestration')
          : (rnd.intentState === 'ANCHOR_TAIL' ? '状态 A：已剥离原始媒体资产，装载上轮产物，精简重组文本润色图' :
             rnd.intentState === 'REBIND_ROOT' ? '状态 B：重置资产指针，全链路重新探索原始素材' :
             rnd.intentState === 'CROSS_FUSION' ? '状态 D：多源融合与跨轮对比，继承历史资产并结合新输入' :
             rnd.intentState === 'SWITCH_BRANCH' ? '状态 E：已切回关联的历史任务分支，挂载该分支产物为基底' :
             '状态 C：断离历史上下文，全新任务独立编排');
        intentPillHtml = `<div class="telemetry-pill intent-telemetry-pill ${stateClass}" title="${titleText}">${compactIntent}</div>`;
      }

      const cachePillHtml = rnd.cached ? `<div class="telemetry-pill cache-telemetry-pill"><span>${isEn ? '⚡ Cached · Fast-Pass' : '⚡ 节省算力: 命中直出'}</span></div>` : '';

      userRow.innerHTML = `
        <div class="msg-avatar-col">
          <div class="msg-avatar-badge user-avatar-badge">${userAvatarHtml}</div>
        </div>
        <div class="msg-content-col">
          <div class="telemetry-meta-bar" id="telemetry-bar-${rnd.runId}">
            <div class="telemetry-pill arb-telemetry-pill locked" id="arb-pill-${rnd.runId}">
              <span class="arb-text" id="arb-text-${rnd.runId}">${getCompactArbitrationText(
                rnd.nodes && rnd.nodes.some(n => n.role_id === 'role_edge_firewall'),
                rnd.nodes && rnd.nodes.some(n => n.role_id === 'role_unreachable'),
                rnd.duration || rnd.latency_ms,
                isEn
              )}</span>
            </div>
            ${intentPillHtml}
            ${cachePillHtml}
          </div>
          <div class="chat-bubble-user">
            ${attachmentsHtml}
            <div class="chat-user-text">${escapeHtml(rnd.userPrompt)}</div>
            <div class="user-action-row">
              <button class="chat-action-btn copy-btn" title="${isEn ? 'Copy' : '复制内容'}" aria-label="${isEn ? 'Copy' : '复制'}">
                <svg class="copy-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                <svg class="check-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#10b981" stroke-width="2.5" style="display:none;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span class="btn-text">${isEn ? 'Copy' : '复制'}</span>
              </button>
            </div>
          </div>
        </div>
      `;
      messagesFlow.appendChild(userRow);

      // 8b. Assistant row
      const assistantRow = document.createElement('div');
      assistantRow.className = 'chat-msg-row assistant';
      const assistantId = 'assistant-msg-' + rnd.runId;
      assistantRow.id = assistantId;

      let stepsHtml = '';
      if (rnd.steps && rnd.steps.length > 0) {
        stepsHtml = rnd.steps.map(s => {
          if (typeof s === 'string') return s;
          if (s.html) return `<div class="${s.className || 'assistant-step-badge completed'}">${s.html}</div>`;
          const timeStr = s.cache_hit ? '⚡ 0ms' : (s.duration_ms ? `${s.duration_ms}ms` : '');
          const roleLabel = isEn ? (s.role_name_en || getCompactRoleName(s.role_id, s.role_name)) : (s.role_name || '节点');
          return `<div class="assistant-step-badge completed"><span class="step-check">✓</span> <span>${escapeHtml(roleLabel)} ${isEn ? 'Done' : '完成'}</span> ${timeStr ? `<span class="step-time">${timeStr}</span>` : ''}</div>`;
        }).join('');
      } else if (rnd.nodes && rnd.nodes.length > 0) {
        stepsHtml = rnd.nodes.map(n => {
          const timeStr = n.cache_hit ? '⚡ 0ms' : (n.duration_ms ? `${n.duration_ms}ms` : '');
          const roleLabel = isEn ? (n.name_en || getCompactRoleName(n.role_id, n.name_zh)) : (n.name_zh || '节点');
          return `<div class="assistant-step-badge completed"><span class="step-check">✓</span> <span>${escapeHtml(roleLabel)} ${isEn ? 'Done' : '完成'}</span> ${timeStr ? `<span class="step-time">${timeStr}</span>` : ''}</div>`;
        }).join('');
      }

      let parsedOutput = '';
      const isFirewallRun = (rnd.nodes && rnd.nodes.some(n => n.role_id === 'role_edge_firewall' || n.status === 'blocked'));
      const isUnreachableRun = (rnd.nodes && rnd.nodes.some(n => n.role_id === 'role_unreachable' || n.status === 'unreachable'));

      if (isFirewallRun) {
        parsedOutput = `
          <div class="security-guardrail-banner">
            <div class="guardrail-header">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>${isEn ? '⚠️ NanoMesh Safety & Compliance Guardrail' : '⚠️ NanoMesh 安全合规防护'}</span>
            </div>
            <div class="guardrail-body">
              <p style="margin: 0 0 10px 0;">
                ${isEn
                  ? 'Sorry, your instruction was audited by the Edge Firewall and flagged for unauthorized system attacks, weaponized exploits, or intellectual property infringements. Execution has been terminated without consuming compute credits. Please refer to <a href="/terms" target="_blank" class="guardrail-link">NanoMesh Terms of Service</a>.'
                  : '抱歉，您的指令经安全网关审计，涉及未授权系统攻击、入侵工具武器化或侵犯版权等违规行为。该请求已被终止执行，未扣除算力点数。请参阅 <a href="/terms" target="_blank" class="guardrail-link">NanoMesh 服务条款</a>。'
                }
              </p>
              <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                ${isEn
                  ? 'If this was intended for defensive security configurations or academic research, please adjust your phrasing. Continued violations may lead to account suspension.'
                  : '如为您自建环境的防御性安全配置或学术分析，请调整表述明确防御上下文。如果您持续进行违规活动，您的账号可能被暂停。'
                }
              </p>
            </div>
          </div>
        `;
      } else if (isUnreachableRun) {
        parsedOutput = `
          <div class="capability-guardrail-banner">
            <div class="guardrail-header">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#818cf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
              </svg>
              <span>${isEn ? '∅ Intent Unreachable / Capability Boundary' : '∅ 意图不可达 / 能力边界熔断'}</span>
            </div>
            <div class="guardrail-body">
              <p style="margin: 0 0 10px 0;">
                ${isEn
                  ? 'No workflow template in the current catalog matches your specific intent. NanoMesh is currently specialized in multimodal visual understanding, entity extraction, cross-lingual translation, and structured polishing. The system has fast-failed to protect your compute credits with 0 charges.'
                  : '当前工作流库未检索到能够胜任该业务意图的编排链路。NanoMesh 目前专精于多模态图文解析、实体信息抽取、跨语言重构与结构化表达润色。系统已在极短时间内快速熔断本轮执行，未消耗您的任何算力点数。'
                }
              </p>
              <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                ${isEn
                  ? '*(Tip: Try uploading multimodal materials or refining your text analysis goals)*'
                  : '*(建议：您可以尝试上传多模态图文材料，或细化您在文字润色、文档抽取方面的诉求)*'
                }
              </p>
            </div>
          </div>
        `;
      } else if (rnd.assistantOutput) {
        const cleanOutput = sanitizePromptLeakage(rnd.assistantOutput);
        parsedOutput = safeRenderMarkdown(cleanOutput);
      }

      const actionsVisibility = (isFirewallRun || isUnreachableRun || !parsedOutput) ? 'style="display:none;"' : '';

      assistantRow.innerHTML = `
        <div class="msg-avatar-col">
          <div class="msg-avatar-badge mesh-avatar-badge" title="NanoMesh Engine">
            <span class="mesh-logo-glyph">◎</span>
          </div>
        </div>
        <div class="msg-content-col">
          <div class="chat-bubble-assistant">
            <div class="assistant-steps-stream" id="assistant-steps-${assistantId}">${stepsHtml}</div>
            <div class="chat-response-wrapper">
              <div class="chat-response-text" id="response-text-${assistantId}">${parsedOutput}</div>
              <div class="chat-response-actions is-visible" id="actions-${assistantId}" ${actionsVisibility}>
                <button class="chat-action-btn copy-btn" title="${isEn ? 'Copy' : '复制内容'}" aria-label="${isEn ? 'Copy' : '复制'}">
                  <svg class="copy-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  <svg class="check-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#10b981" stroke-width="2.5" style="display:none;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  <span class="btn-text">${isEn ? 'Copy' : '复制'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesFlow.appendChild(assistantRow);
    });

    // 9. Restore DAG canvas from the last round
    const lastRound = rounds[rounds.length - 1] || {};
    const nodesToRender = (lastRound.nodes && lastRound.nodes.length > 0) ? lastRound.nodes : (record.nodes || []);
    activeDagNodes = JSON.parse(JSON.stringify(nodesToRender || []));

    window.activeRoundPayload = {
      prompt: lastRound.userPrompt || record.title || '',
      files: lastRound.assets || []
    };
    window.currentRoundIntentState = lastRound.intentState || null;

    if (nodesToRender.length > 0) {
      renderDagNodesWithAnchors(nodesToRender, {
        prompt: lastRound.userPrompt || record.title || '',
        assets: lastRound.assets || [],
        intentState: lastRound.intentState || null,
        isFirewall: nodesToRender.some(n => n.role_id === 'role_edge_firewall'),
        isUnreachable: nodesToRender.some(n => n.role_id === 'role_unreachable'),
        isHistory: true
      });
      // Ensure curves are drawn across animation frames after history snapshot loads
      requestAnimationFrame(() => renderDagSvgConnectors());
      setTimeout(() => renderDagSvgConnectors(), 80);
      setTimeout(() => renderDagSvgConnectors(), 220);
      setTimeout(() => renderDagSvgConnectors(), 520);
    }

    const routeChain = document.getElementById('macro-route-chain');
    if (routeChain && nodesToRender.length > 0) {
      routeChain.textContent = nodesToRender.map(n => getCompactRoleName(n.role_id, n.name_zh, n.name_en)).join(' ➔ ');
    }

    // Set Macro Capsule to Snapshot mode for history viewing
    const macroLabel = document.getElementById('macro-label') || document.querySelector('.macro-label');
    const lockIcon = document.getElementById('macro-lock-icon');
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    if (macroLabel) {
      macroLabel.textContent = isEn ? 'Snapshot:' : '快照:';
    }
    if (lockIcon) {
      lockIcon.style.display = 'inline';
    }

    // 10. Restore candidate templates and macro route dropdown if present
    if (lastRound.candidateTemplates && lastRound.candidateTemplates.length > 0) {
      currentCandidateTemplates = lastRound.candidateTemplates;
      window.currentRunningTemplateId = lastRound.template?.template_id;
      const macroDropdown = document.getElementById('macro-dropdown');
      const macroCapsuleBtn = document.getElementById('macro-capsule-btn');
      if (macroCapsuleBtn && macroDropdown) {
        macroCapsuleBtn.onclick = (e) => {
          e.stopPropagation();
          if (isWorkflowExecuting) return;
          macroDropdown.style.display = macroDropdown.style.display === 'none' ? 'block' : 'none';
        };
        macroDropdown.innerHTML = currentCandidateTemplates.map((t, idx) => {
          const tplTitle = isEn 
            ? `${idx === 0 ? '🏆' : (idx === 1 ? '⚡' : '🔍')} Route ${idx + 1}: ${escapeHtml(getCompactTemplateName(t.template_id, t.name_zh, t.name_en))}`
            : `${idx === 0 ? '🏆' : (idx === 1 ? '⚡' : '🔍')} 路线 ${idx + 1}: ${escapeHtml(t.name_zh)}`;
          const tplDesc = isEn
            ? (idx === 0 ? 'Optimal match · Recommended' : (idx === 1 ? 'Cost saver · Save 40% ⚡' : 'Low latency direct route'))
            : (idx === 0 ? '综合胜任度最高 · 智能推荐' : (idx === 1 ? '更省算力 · 预估节省 40% ⚡' : '低时延直出路线'));
          return `
            <div class="macro-dropdown-item ${t.template_id === window.currentRunningTemplateId ? 'active' : ''}" data-tpl-id="${t.template_id}">
              <div style="font-weight:600; font-size:0.85rem; color:var(--text-primary);">
                ${tplTitle}
              </div>
              <div style="font-size:0.74rem; color:var(--text-secondary); margin-top:2px;">
                ${tplDesc}
              </div>
            </div>
          `;
        }).join('');

        macroDropdown.querySelectorAll('.macro-dropdown-item').forEach(item => {
          item.onclick = (e) => {
            e.stopPropagation();
            if (isWorkflowExecuting) return;
            const chosenId = item.getAttribute('data-tpl-id');
            macroDropdown.style.display = 'none';
            if (chosenId !== window.currentRunningTemplateId) {
              if (window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.size > 0) {
                const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
                const msg = isEn 
                  ? 'Switching workflow routes will discard unsaved node modifications. Proceed?' 
                  : '切换工作流路线将放弃当前节点未应用的微调，是否确认切换？';
                if (!confirm(msg)) return;
                window.pendingModifiedRoleIds.clear();
                window.activeCustomRolePrompts = {};
                updateRerouteButtonState();
              }
              sendChatMessage({
                isSwitch: true,
                reRouteMode: 'switch_template',
                chosenTemplateId: chosenId,
                customPrompt: window.lastUserPrompt || '切换工作流'
              });
            }
          };
        });
      }
    }

    // 11. Restore session parameters for next follow-up round
    window.chatSessionId = record.sessionId || record.id;
    window.chatRoundIndex = rounds.length;
    window.lastRoundSummary = lastRound.assistantOutput ? lastRound.assistantOutput.slice(0, 4000) : '';
    window.currentDagBaseSummary = window.lastRoundSummary;
    window.lastUserPrompt = lastRound.userPrompt || record.title || '';
    window.sessionAssets = [];
    window.sessionBranches = { 'main': { branchId: 'main', isMediaBranch: false, lastValidSummary: window.lastRoundSummary, assetIds: [] } };
    window.activeBranchId = 'main';
    window._currentPreFlightSnapshot = null;
    window._currentStagedNewFiles = [];
    rounds.forEach(r => {
      if (r.assets && Array.isArray(r.assets)) {
        r.assets.forEach(a => {
          if (!window.sessionAssets.some(sa => sa.assetId === a.assetId || (sa.name === a.name && sa.size === a.size))) {
            window.sessionAssets.push(a);
          }
        });
      }
      if (r.branchId) {
        window.sessionBranches[r.branchId] = {
          branchId: r.branchId,
          isMediaBranch: !!(r.assets && r.assets.some(a => a.modality === 'image' || a.modality === 'audio')),
          lastValidSummary: r.assistantOutput ? r.assistantOutput.slice(0, 4000) : ''
        };
        window.activeBranchId = r.branchId;
      }
    });
    window.lastHadMedia = window.sessionAssets.some(a => {
      const m = a.modality || (a.type && a.type.startsWith('image/') ? 'image' : (a.type && a.type.startsWith('audio/') ? 'audio' : ''));
      return m === 'image' || m === 'audio';
    });

    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = false;

    // 12. Re-render drawer list to mark active card
    renderHistoryList();

    // 13. Scroll to bottom
    const scrollContainer = document.getElementById('chat-messages');
    if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }

  function renderHistoryList() {
    const listEl = document.getElementById('history-drawer-list');
    if (!listEl) return;
    try {
      let history = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
      let updated = false;
      history.forEach((item, idx) => {
        if (!item.id) {
          item.id = 'trace-' + (item.timestamp || (Date.now() - idx * 1000)) + '-' + idx;
          updated = true;
        }
      });
      if (updated) {
        localStorage.setItem('nanomesh_trace_history', JSON.stringify(history));
      }

      // Sort pinned items to the very top, then descending by timestamp
      history.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });

      if (history.length === 0) {
        listEl.innerHTML = '<div class="history-empty" data-i18n="history.empty">暂无历史记录</div>';
        return;
      }

      listEl.innerHTML = history.map(item => {
        const isActive = (window.chatSessionId && item.sessionId === window.chatSessionId);
        return `
        <div class="history-trace-card ${item.pinned ? 'is-pinned' : ''} ${isActive ? 'is-active' : ''}" data-trace-id="${escapeHtml(item.id)}" data-session-id="${escapeHtml(item.sessionId || '')}">
          <div class="trace-dot ${item.cached ? 'amber' : 'green'}"></div>
          <div class="trace-body">
            <div class="trace-title-row">
              <span class="trace-title" title="${escapeHtml(item.title || '多模态任务编排')}">${escapeHtml(item.title || '多模态任务编排')}</span>
              ${item.pinned ? '<span class="trace-pin-icon" title="已固定置顶">📌</span>' : ''}
            </div>
            <div class="trace-meta">
              <span class="cost">${escapeHtml(item.cost || '120')} ⚡</span>
              <span>·</span>
              <span>${escapeHtml(item.duration || '2.1s')}</span>
              <span>·</span>
              <span>${item.nodesCount || 1} 节点</span>
            </div>
          </div>
          <div class="trace-actions" id="trace-actions-${escapeHtml(item.id)}">
            <button class="trace-more-btn" title="更多操作" aria-label="更多操作" data-id="${escapeHtml(item.id)}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <circle cx="12" cy="5" r="2.2"></circle>
                <circle cx="12" cy="12" r="2.2"></circle>
                <circle cx="12" cy="19" r="2.2"></circle>
              </svg>
            </button>
          </div>
        </div>
      `;
      }).join('');

      // Bind actions & interactions for each trace card
      listEl.querySelectorAll('.history-trace-card').forEach(card => {
        const traceId = card.getAttribute('data-trace-id');
        const moreBtn = card.querySelector('.trace-more-btn');

        // 3-dots button trigger: opens fixed portal popover menu to the right
        if (moreBtn) {
          moreBtn.onclick = (e) => {
            e.stopPropagation();
            openFixedTraceMenu(traceId, moreBtn);
          };
        }

        // Clicking card restores entire conversation into chat view and DAG canvas
        card.onclick = (e) => {
          if (e.target.closest('.trace-actions') || e.target.closest('.trace-more-btn')) return;
          const hList = JSON.parse(localStorage.getItem('nanomesh_trace_history') || '[]');
          const target = hList.find(x => x.id === traceId);
          if (target) {
            restoreConversationFromHistory(target);
          }
        };
      });

    } catch (e) {
      console.warn('Failed to render history list:', e);
    }
  }

  // ==========================================================
  // Stage 3: Industrial-Grade DAG Dataflow Engine
  // ==========================================================

  window.stateAConsecutiveCount = 0;
  window.isStackExpanded = false;

  function renderDagNodesWithAnchors(nodesToRender, options = {}) {
    window.lastDagNodesToRender = nodesToRender;
    window.lastDagOptions = options;
    const nodesContainer = document.getElementById('dag-nodes-container');
    if (!nodesContainer) return;

    const isFirewall = options.isFirewall || false;
    const isUnreachable = options.isUnreachable || false;
    const intentState = options.intentState || window.currentRoundIntentState || null;
    const promptText = options.prompt || window.lastUserPrompt || '';
    const assets = options.assets || (window.activeRoundPayload && window.activeRoundPayload.files) || [];
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';

    // State C: Smooth Canvas Sweep Transition
    if (options.doSweep) {
      nodesContainer.classList.add('dag-sweep-exit');
      setTimeout(() => {
        nodesContainer.classList.remove('dag-sweep-exit');
        nodesContainer.classList.add('dag-sweep-enter');
        setTimeout(() => nodesContainer.classList.remove('dag-sweep-enter'), 350);
      }, 300);
    }

    const isStateA = intentState === 'ANCHOR_TAIL';
    const isStateB = intentState === 'REBIND_ROOT';
    const hasSupplements = assets && assets.some(a => a.isNew);

    // 1. Build Origin Anchor (Head Node: Input Payload)
    let promptSnippet = promptText.trim().replace(/\s+/g, ' ');
    if (promptSnippet.length > 20) promptSnippet = promptSnippet.slice(0, 19) + '…';

    let inventoryItemsHtml = '';
    if (isStateA) {
      // State A: Local tweak on previous output. Raw media was stripped, consuming previous text context (0 image tokens)
      const textDocItems = (assets || []).filter(a => a.modality === 'text' || a.modality === 'text_doc').map(f => {
        const sizeStr = formatFileSize(f.size);
        return `
          <div class="origin-payload-item is-supplemented" title="${isEn ? 'Supplement Doc: ' : '补充文档: '}${escapeHtml(f.name)} (${sizeStr})">
            <span class="payload-badge file-badge">📄</span>
            <span class="payload-filename">${escapeHtml(f.name)}</span>
            <span class="payload-filesize font-mono">${sizeStr}</span>
          </div>
        `;
      }).join('');

      inventoryItemsHtml = `
        <div class="origin-payload-item" title="${isEn ? 'Inherited Previous Output Context (Text)' : '继承上轮模型交付物基底'}">
          <span class="payload-badge">📄</span>
          <span class="payload-filename">${isEn ? 'Upstream Turn Output' : '上轮产物基底'}</span>
          <span class="payload-filesize font-mono">${isEn ? 'Ready' : '基底就绪'}</span>
        </div>
        ${textDocItems}
      `;
    } else if (isStateB && hasSupplements) {
      // State B with supplemented assets: Fusion of previous context + new media!
      const assetCards = (assets || []).map(f => {
        const sizeStr = formatFileSize(f.size);
        const isImg = f.previewUrl || (f.type && f.type.startsWith('image/')) || f.modality === 'image';
        const isPdf = (f.name || '').toLowerCase().endsWith('.pdf') || f.modality === 'pdf';
        const isAudio = (f.name || '').toLowerCase().endsWith('.mp3') || (f.name || '').toLowerCase().endsWith('.wav') || f.modality === 'audio';
        const badgeIcon = isImg ? '🖼️' : isPdf ? '📄' : isAudio ? '🎙️' : '📎';
        const prefix = f.isNew ? (isEn ? 'New: ' : '补充: ') : (isEn ? 'Prior: ' : '原素材: ');
        return `
          <div class="origin-payload-item ${f.isNew ? 'is-supplemented' : ''}" title="${escapeHtml(f.name)} (${sizeStr})">
            <span class="payload-badge file-badge">${f.isNew ? '➕ ' : ''}${badgeIcon}</span>
            <span class="payload-filename">${prefix}${escapeHtml(f.name)}</span>
            <span class="payload-filesize font-mono">${sizeStr}</span>
          </div>
        `;
      }).join('');

      inventoryItemsHtml = `
        <div class="origin-payload-item" title="${isEn ? 'Inherited Previous Output Summary for cross-asset fusion' : '继承上轮交付基底，用于跨素材联合比对/推理'}">
          <span class="payload-badge">📄</span>
          <span class="payload-filename">${isEn ? 'Prior Turn Context' : '上轮产物基底'}</span>
          <span class="payload-filesize font-mono">${isEn ? 'Ready' : '基底就绪'}</span>
        </div>
        ${assetCards}
      `;
    } else if (assets && assets.length > 0) {
      inventoryItemsHtml = assets.map(f => {
        const sizeStr = formatFileSize(f.size);
        const isImg = f.previewUrl || (f.type && f.type.startsWith('image/')) || f.modality === 'image';
        const isPdf = (f.name || '').toLowerCase().endsWith('.pdf') || f.modality === 'pdf';
        const isAudio = (f.name || '').toLowerCase().endsWith('.mp3') || (f.name || '').toLowerCase().endsWith('.wav') || f.modality === 'audio';
        const badgeIcon = isImg ? '🖼️' : isPdf ? '📄' : isAudio ? '🎙️' : '📎';
        return `
          <div class="origin-payload-item" title="${escapeHtml(f.name)} (${sizeStr})">
            <span class="payload-badge file-badge">${badgeIcon}</span>
            <span class="payload-filename">${escapeHtml(f.name)}</span>
            <span class="payload-filesize font-mono">${sizeStr}</span>
          </div>
        `;
      }).join('');
    } else {
      inventoryItemsHtml = `
        <div class="origin-payload-item muted">
          <span class="payload-badge">📎</span>
          <span class="payload-filename">${isEn ? 'Plain Text' : '纯文本无多模态'}</span>
        </div>
      `;
    }

    const originAnchorHtml = `
      <div class="dag-origin-anchor ${intentState === 'REBIND_ROOT' ? 'origin-rebind-active' : ''}" id="dag-origin-anchor" title="${isEn ? 'Origin Input Payload (Immutable)' : '初始输入载荷清单 (不可修改既定事实)'}">
        <div class="origin-header">
          <span class="origin-title">
            <span>📥</span>
            <span>${isEn ? 'Input Payload' : '初始载荷'}</span>
          </span>
          <span class="origin-meta font-mono">${isEn ? 'P₀ Root' : 'P₀ 源头'}</span>
        </div>
        <div class="origin-payload-inventory">
          <div class="origin-payload-item" title="${escapeHtml(promptText)}">
            <span class="payload-badge">💬</span>
            <span class="payload-text-preview">${isStateA ? (isEn ? 'Delta: ' : '增量诉求: ') : (isStateB && hasSupplements ? (isEn ? 'Fusion: ' : '联合诉求: ') : '')}${escapeHtml(promptSnippet || (isEn ? 'Directive' : '原始指令'))}</span>
          </div>
          ${inventoryItemsHtml}
        </div>
      </div>
    `;

    // 2. Build Work Nodes
    let workNodesHtml = '';
    if (isFirewall) {
      workNodesHtml = `
        <div class="dag-node-card dag-work-node is-firewall" id="dag-node-role_edge_firewall" data-role-id="role_edge_firewall">
          <span class="dag-blocked-stamp">🛑 BLOCKED</span>
          <div class="node-card-header">
            <span class="node-card-title">
              <span class="status-dot"></span>
              ${isEn ? 'Edge Firewall' : '边界防御网关'}
            </span>
            <span class="node-card-meta" id="node-meta-role_edge_firewall">${isEn ? 'BLOCKED' : '拦截阻断'}</span>
          </div>
          <div class="dag-consumption-receipt font-mono">
            ↳ ${isEn ? 'Safety audit: Request Terminated' : '安全审计阻断：执行已终止'}
          </div>
          <div class="node-card-model" id="node-model-label-role_edge_firewall">
            🛡️ ${isEn ? 'Edge Security Firewall' : '边界防御网关'}
          </div>
        </div>
      `;
    } else if (isUnreachable) {
      workNodesHtml = `
        <div class="dag-node-card dag-work-node is-unreachable" id="dag-node-role_unreachable" data-role-id="role_unreachable">
          <span class="dag-zero-cost-stamp">0 ⚡ 零消耗</span>
          <div class="node-card-header">
            <span class="node-card-title">
              <span class="status-dot"></span>
              ${isEn ? 'Capability Boundary' : '意图不可达'}
            </span>
            <span class="node-card-meta" id="node-meta-role_unreachable">0ms</span>
          </div>
          <div class="dag-consumption-receipt font-mono">
            ↳ ${isEn ? '0 Tokens Consumed · Fast-Failed' : '零消耗快速熔断 · 未扣除算力'}
          </div>
          <div class="node-card-model" id="node-model-label-role_unreachable">
            ∅ ${isEn ? 'Capability Boundary' : '能力边界拦截'}
          </div>
        </div>
      `;
    } else {
      const isStateA = intentState === 'ANCHOR_TAIL';
      const consecutiveA = window.stateAConsecutiveCount || 0;
      const shouldCollapse = isStateA && consecutiveA >= 2 && !window.isStackExpanded;

      let collapseCardHtml = '';
      const nodesArray = nodesToRender || [];

      if (shouldCollapse && nodesArray.length > 1) {
        collapseCardHtml = `
          <div class="dag-stack-collapse-card" id="dag-stack-collapse" title="${isEn ? 'Click to expand historical revisions' : '点击展开前序历史修正'}">
            <span>🗂️</span>
            <span>${isEn ? `${consecutiveA} Revisions Folded` : `${consecutiveA} 次历史修正已折叠`}</span>
          </div>
        `;
      }

      workNodesHtml = collapseCardHtml + nodesArray.map((n, idx) => {
        const isNodeFirewall = (n.role_id === 'role_edge_firewall') || n.status === 'blocked';
        const isNodeUnreachable = (n.role_id === 'role_unreachable') || n.status === 'unreachable';
        const isPending = !isNodeFirewall && !isNodeUnreachable && window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.has(n.role_id);
        const isCached = !isNodeFirewall && !isNodeUnreachable && !isPending && !!n.cache_hit;
        const isGhost = isStateA && idx < nodesArray.length - 1;

        let stampHtml = '';
        let cardClasses = 'dag-node-card dag-work-node';
        let metaText = isCached ? '⚡ 0ms' : (n.duration_ms ? `${n.duration_ms}ms` : (isEn ? 'Wait' : '等待'));

        if (isPending) {
          cardClasses += ' is-pending';
          stampHtml = `<span class="dag-node-pending-stamp">${isEn ? 'Pending' : '待更新 (Pending)'}</span>`;
        } else if (isCached) {
          cardClasses += ' cached';
          stampHtml = '<span class="dag-cache-hit-stamp">⚡ HIT</span>';
        } else if (n.status === 'completed' || n.duration_ms) {
          cardClasses += ' completed';
        }

        if (isGhost) {
          cardClasses += ' is-ghost-card';
        }

        // Dynamic Asset Consumption Receipt
        let receiptText = '';
        if (isStateA) {
          const hasDoc = assets && assets.some(a => a.modality === 'text_doc' || a.modality === 'text');
          receiptText = isEn
            ? (hasDoc ? 'Inputs: 📄 Upstream Output · 📄 Supplement Doc' : 'Inputs: 📄 Upstream Output · 💬 Tweak Directive')
            : (hasDoc ? '依赖: 📄 上轮产物基底 · 📄 补充文本文档' : '依赖: 📄 上轮产物基底 · 💬 增量指令');
        } else if (idx === 0) {
          const hasNewSupplement = assets && assets.some(a => a.isNew);
          if (isStateB && hasNewSupplement) {
            receiptText = isEn
              ? 'Inputs: 📄 Prior Output · 🖼️ Supplement Asset · 💬 Fusion Directive'
              : '依赖: 📄 上轮基底 · 🖼️ 补充素材 · 💬 联合指令';
          } else if (isStateB) {
            receiptText = isEn
              ? 'Inputs: 🖼️ Raw Assets · 💬 Re-inspection Directive'
              : '依赖: 🖼️ 原始素材 · 💬 回溯重探指令';
          } else {
            const hasImg = assets.some(a => a.previewUrl || (a.type && a.type.startsWith('image/')) || a.modality === 'image');
            const hasPdf = assets.some(a => (a.name || '').toLowerCase().endsWith('.pdf') || a.modality === 'pdf');
            const hasAudio = assets.some(a => (a.name || '').toLowerCase().endsWith('.mp3') || a.modality === 'audio');

            if (hasImg) {
              receiptText = isEn ? 'Inputs: 🖼️ Raw Image · 💬 Directive' : '依赖: 🖼️ 原始图片 · 💬 提取指令';
            } else if (hasPdf) {
              receiptText = isEn ? 'Inputs: 📄 Document · 💬 Directive' : '依赖: 📄 原始文档 · 💬 提取指令';
            } else if (hasAudio) {
              receiptText = isEn ? 'Inputs: 🎙️ Audio · 💬 Directive' : '依赖: 🎙️ 原始音频 · 💬 提取指令';
            } else {
              receiptText = isEn ? 'Inputs: 💬 Raw Directive' : '依赖: 💬 原始指令';
            }
          }
        } else {
          receiptText = isEn
            ? 'Inputs: 📄 Upstream Draft'
            : '依赖: 📄 上游结构化草稿';
        }

        const rawModelId = (n.selected_model && (n.selected_model.id || n.selected_model.model_id)) || n.model_id || '';
        const rawDisplayName = (n.selected_model && n.selected_model.display_name) || n.model_name || '';
        const isBrowserModel = (n.selected_model && n.selected_model.inference_target === 'browser') || rawModelId.startsWith('browser-');
        const modelIcon = isBrowserModel ? '💻' : '⚙️';
        const modelName = getCompactModelName(rawModelId, rawDisplayName);
        const displayName = getCompactRoleName(n.role_id, n.name_zh, n.name_en);
        const microBadgeHtml = isBrowserModel 
          ? `<span class="dag-card-micro-badge font-mono" title="${isEn ? 'Downloaded once, cached locally' : '仅首次需下载，随后持久化至浏览器本地'}">⚡ ${isEn ? 'Cached locally on device' : '仅首次需下载，随后持久化至本地'}</span>` 
          : '';

        return `
          <div class="${cardClasses}" id="dag-node-${n.role_id}" data-role-id="${n.role_id}" ${shouldCollapse && isGhost ? 'style="display:none;"' : ''}>
            ${stampHtml}
            <div class="node-card-header">
              <span class="node-card-title">
                <span class="status-dot"></span>
                ${escapeHtml(displayName || n.role_id)}
              </span>
              <span class="node-card-meta" id="node-meta-${n.role_id}">${metaText}</span>
            </div>
            <div class="dag-consumption-receipt font-mono" title="↳ ${escapeHtml(receiptText)}">
              ↳ ${escapeHtml(receiptText)}
            </div>
            <div class="node-card-model" id="node-model-label-${n.role_id}">
              ${modelIcon} ${escapeHtml(modelName)}
            </div>
            ${microBadgeHtml}
          </div>
        `;
      }).join('');
    }

    // 3. Build Output Sink Anchor
    const isExecuting = window.isWorkflowExecuting || false;
    const isFirewallOrUnreachable = isFirewall || isUnreachable;
    const allWorkDone = !isFirewallOrUnreachable && nodesToRender && nodesToRender.length > 0 && nodesToRender.every(n => n.status === 'completed' || n.duration_ms || n.cache_hit);
    const isSinkCompleted = !isExecuting && !isFirewallOrUnreachable && (options.isHistory || allWorkDone);

    const sinkAnchorHtml = `
      <div class="dag-sink-anchor ${isExecuting ? 'is-executing' : ''} ${isSinkCompleted ? 'completed' : ''}" id="dag-sink-anchor" title="${isEn ? 'Final Convergence: Render to terminal stream' : '终局汇聚：平滑渲染至终端对话流'}">
        <span class="sink-funnel-icon">➔</span>
        <span class="sink-label">${isEn ? 'Terminal Stream' : '渲染至终端'}</span>
      </div>
    `;

    nodesContainer.innerHTML = originAnchorHtml + workNodesHtml + sinkAnchorHtml;

    // Bind stack collapse card toggle
    const collapseBtn = document.getElementById('dag-stack-collapse');
    if (collapseBtn) {
      collapseBtn.onclick = (e) => {
        e.stopPropagation();
        window.isStackExpanded = !window.isStackExpanded;
        renderDagNodesWithAnchors(nodesToRender, options);
      };
    }

    // Bind click on work nodes to open Node Inspector
    nodesContainer.querySelectorAll('.dag-work-node').forEach(card => {
      card.onclick = (e) => {
        e.stopPropagation();
        if (window.isWorkflowExecuting) return;
        const roleId = card.getAttribute('data-role-id');
        if (roleId === 'role_edge_firewall' || roleId === 'role_unreachable') return;
        const nodeData = activeDagNodes.find(nd => nd.role_id === roleId);
        if (nodeData) openNodeInspector(card, nodeData);
      };
    });

    // Multi-phase measurement passes to guarantee connector curves across layout & animation frames
    requestAnimationFrame(() => renderDagSvgConnectors());
    setTimeout(() => renderDagSvgConnectors(), 60);
    setTimeout(() => renderDagSvgConnectors(), 200);
    setTimeout(() => renderDagSvgConnectors(), 520);
  }

  // Stage 3: Smooth Cubic Bézier Connectors on DAG Canvas (Strict Horizontal Tangents)
  function renderDagSvgConnectors(isReverse = false) {
    const svg = document.getElementById('dag-svg-canvas');
    const container = document.getElementById('dag-nodes-container');
    const canvasContainer = document.getElementById('dag-canvas-container');
    if (!svg || !container) return;

    const originAnchor = document.getElementById('dag-origin-anchor');
    const visibleWorkCards = Array.from(container.querySelectorAll('.dag-work-node:not([style*="display: none"]):not([style*="display:none"])'));
    const sinkAnchor = document.getElementById('dag-sink-anchor');

    const chain = [];
    if (originAnchor) chain.push(originAnchor);
    chain.push(...visibleWorkCards);
    if (sinkAnchor) chain.push(sinkAnchor);

    if (chain.length < 2) {
      svg.innerHTML = '';
      return;
    }

    // Match SVG dimensions to canvas container's scroll size so edges don't clip on horizontal scroll
    if (canvasContainer) {
      const scrollW = Math.max(canvasContainer.scrollWidth, canvasContainer.clientWidth);
      const scrollH = Math.max(canvasContainer.scrollHeight, canvasContainer.clientHeight);
      if (scrollW > 0 && scrollH > 0) {
        svg.style.width = scrollW + 'px';
        svg.style.height = scrollH + 'px';
      }
    }

    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || svgRect.height === 0) {
      // Workbench pane is mid-transition or not yet laid out; schedule a retry once layout settles
      if (!window._dagRetryScheduled) {
        window._dagRetryScheduled = true;
        requestAnimationFrame(() => {
          window._dagRetryScheduled = false;
          renderDagSvgConnectors(isReverse);
        });
      }
      return;
    }

    // Check if initial elements have zero width (still being styled/rendered)
    const firstRect = chain[0].getBoundingClientRect();
    const lastRect = chain[chain.length - 1].getBoundingClientRect();
    if (firstRect.width === 0 || lastRect.width === 0) {
      if (!window._dagRetryScheduled) {
        window._dagRetryScheduled = true;
        setTimeout(() => {
          window._dagRetryScheduled = false;
          renderDagSvgConnectors(isReverse);
        }, 50);
      }
      return;
    }

    let paths = '';

    for (let i = 0; i < chain.length - 1; i++) {
      const c1 = chain[i];
      const c2 = chain[i + 1];
      const r1 = c1.getBoundingClientRect();
      const r2 = c2.getBoundingClientRect();

      const x1 = r1.right - svgRect.left;
      const y1 = r1.top + r1.height / 2 - svgRect.top;
      const x2 = r2.left - svgRect.left;
      const y2 = r2.top + r2.height / 2 - svgRect.top;

      const dx = Math.max(35, (x2 - x1) * 0.45);
      const cp1x = x1 + dx;
      const cp1y = y1; // strictly horizontal tangent at output port!
      const cp2x = x2 - dx;
      const cp2y = y2; // strictly horizontal tangent at input port!

      const d = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;

      const isTargetExecuting = c2.classList.contains('running') || c2.classList.contains('is-executing');
      const isTargetPending = c2.classList.contains('is-pending');
      const isTargetCompleted = c2.classList.contains('completed') || c2.classList.contains('cached');
      const isTargetGhost = c2.classList.contains('is-ghost-card');

      let groupClass = 'dag-edge-group';
      if (isTargetExecuting) {
        groupClass += ' is-executing';
      } else if (isTargetPending) {
        groupClass += ' is-pending';
      } else if (isTargetCompleted) {
        groupClass += ' is-completed';
      }

      if (isTargetGhost) {
        paths += `
          <g class="${groupClass}">
            <path class="dag-edge-ghost" d="${d}" />
          </g>
        `;
      } else {
        paths += `
          <g class="${groupClass}">
            <path class="dag-edge-base" d="${d}" />
            <path class="dag-edge-flow" d="${d}" />
          </g>
        `;
      }
    }

    // State B Branching Edge: Downward-curved branch from Origin Anchor
    if (window.currentRoundIntentState === 'REBIND_ROOT' && originAnchor && visibleWorkCards.length > 0) {
      const r0 = originAnchor.getBoundingClientRect();
      const targetCard = visibleWorkCards[0];
      const rt = targetCard.getBoundingClientRect();
      const bx1 = r0.right - svgRect.left;
      const by1 = r0.top + r0.height * 0.75 - svgRect.top;
      const bx2 = rt.left - svgRect.left;
      const by2 = rt.top + rt.height * 0.75 - svgRect.top;
      const bdx = Math.max(40, (bx2 - bx1) * 0.5);
      const bd = `M ${bx1} ${by1} C ${bx1 + bdx} ${by1 + 25}, ${bx2 - bdx} ${by2 + 25}, ${bx2} ${by2}`;
      paths += `
        <g class="dag-edge-group">
          <path class="dag-branch-edge" d="${bd}" />
        </g>
      `;
    }

    svg.innerHTML = paths;
  }
  window.addEventListener('resize', () => renderDagSvgConnectors());

  let dagResizeObserver = null;
  function initDagResizeObserver() {
    const container = document.getElementById('dag-nodes-container');
    const canvasContainer = document.getElementById('dag-canvas-container');
    const workbenchPane = document.querySelector('.workbench-canvas-pane');
    if (dagResizeObserver) return;
    if (window.ResizeObserver) {
      dagResizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => renderDagSvgConnectors());
      });
      if (container) dagResizeObserver.observe(container);
      if (canvasContainer) dagResizeObserver.observe(canvasContainer);
      if (workbenchPane) dagResizeObserver.observe(workbenchPane);
    }
    if (workbenchPane) {
      workbenchPane.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'width' || e.propertyName === 'opacity') {
          renderDagSvgConnectors();
        }
      });
    }
    if (canvasContainer) {
      canvasContainer.addEventListener('scroll', () => {
        renderDagSvgConnectors();
      }, { passive: true });
    }
  }

  let currentInspectedNodeRoleId = null;
  window.originalNodeConfigs = window.originalNodeConfigs || {};
  window.pendingModifiedRoleIds = window.pendingModifiedRoleIds || new Set();

  function updateNodeDirtyState(roleId) {
    const orig = window.originalNodeConfigs?.[roleId] || {};
    const currentModel = window.activeChosenRoleModels?.[roleId] || orig.model_id;
    const currentPrompt = (window.activeCustomRolePrompts?.[roleId] !== undefined)
      ? window.activeCustomRolePrompts[roleId]
      : (orig.custom_prompt || '');

    const isDirty = (orig.model_id && currentModel !== orig.model_id) ||
                    (currentPrompt !== (orig.custom_prompt || ''));

    const card = document.getElementById('dag-node-' + roleId);
    if (isDirty) {
      window.pendingModifiedRoleIds.add(roleId);
      if (card) {
        card.classList.add('is-pending');
        // Hide/remove green cache hit stamp if any
        const hitStamp = card.querySelector('.dag-cache-hit-stamp');
        if (hitStamp) hitStamp.remove();
        // Add pending stamp if not exists
        if (!card.querySelector('.dag-node-pending-stamp')) {
          const stamp = document.createElement('span');
          stamp.className = 'dag-node-pending-stamp';
          stamp.textContent = '待更新 (Pending)';
          card.appendChild(stamp);
        }
      }
    } else {
      window.pendingModifiedRoleIds.delete(roleId);
      if (card) {
        card.classList.remove('is-pending');
        const pendingStamp = card.querySelector('.dag-node-pending-stamp');
        if (pendingStamp) pendingStamp.remove();
      }
    }

    updateRerouteButtonState();
  }

  function updateRerouteButtonState() {
    const rerouteBtn = document.getElementById('macro-reroute-btn');
    const labelEl = document.getElementById('macro-reroute-label');
    const inputArea = document.getElementById('input-area');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';

    const hasPending = Boolean(window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.size > 0);

    if (hasPending) {
      if (rerouteBtn) {
        rerouteBtn.disabled = false;
        rerouteBtn.classList.add('active');
        if (labelEl) labelEl.textContent = isEn ? 'Apply & Rerun' : '应用并重跑';
      }
      if (inputArea) {
        inputArea.classList.add('pending-canvas-sync');
      }
      if (chatInput) {
        chatInput.disabled = true;
        chatInput.placeholder = isEn ? '⚡ Please apply canvas changes first...' : '⚡ 请先应用左侧画布的修改...';
      }
      if (sendBtn) {
        sendBtn.classList.add('btn-morph-pending');
        sendBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        `;
        sendBtn.setAttribute('title', isEn ? 'Run Canvas Changes' : '运行画布更改');
      }
    } else {
      if (rerouteBtn) {
        rerouteBtn.disabled = true;
        rerouteBtn.classList.remove('active');
        if (labelEl) labelEl.textContent = isEn ? 'Reroute' : '重新路由';
      }
      if (inputArea) {
        inputArea.classList.remove('pending-canvas-sync');
      }
      if (chatInput && !isWorkflowExecuting) {
        chatInput.disabled = false;
        chatInput.placeholder = isEn 
          ? 'Enter prompt to analyze image, audio or text...' 
          : '输入指令，分析图片，音频或文本。';
      }
      if (sendBtn) {
        sendBtn.classList.remove('btn-morph-pending');
        sendBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        `;
        sendBtn.setAttribute('title', isEn ? 'Send' : '发送');
      }
    }
  }

  function applyPendingCanvasChanges() {
    if (isWorkflowExecuting || !window.pendingModifiedRoleIds || window.pendingModifiedRoleIds.size === 0) return;

    // 1. Clear Pending UI on cards
    window.pendingModifiedRoleIds.forEach(roleId => {
      const card = document.getElementById('dag-node-' + roleId);
      if (card) {
        card.classList.remove('is-pending');
        const pendingStamp = card.querySelector('.dag-node-pending-stamp');
        if (pendingStamp) pendingStamp.remove();
      }
    });
    window.pendingModifiedRoleIds.clear();
    updateRerouteButtonState();

    // 2. Ensure ALL active DAG nodes have their model ID captured
    const completeRoleModels = { ...(window.activeChosenRoleModels || {}) };
    activeDagNodes.forEach(n => {
      if (!completeRoleModels[n.role_id] && n.selected_model?.model_id) {
        completeRoleModels[n.role_id] = n.selected_model.model_id;
      }
    });

    // 3. Trigger execution with active customizations (Scenario 3: Direct to Step 4)
    sendChatMessage({
      isSwitch: true,
      reRouteMode: 'switch_model',
      chosenTemplateId: window.currentRunningTemplateId,
      chosenRoleModels: completeRoleModels,
      customRolePrompts: window.activeCustomRolePrompts,
      customPrompt: window.lastUserPrompt || '执行任务'
    });
  }

  function initMacroRerouteButton() {
    const rerouteBtn = document.getElementById('macro-reroute-btn');
    if (!rerouteBtn) return;
    rerouteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyPendingCanvasChanges();
    });
  }

  // Stage 3: Node Inspector Popover (Lightweight Properties Panel with Auto-save)
  function openNodeInspector(cardEl, nodeData) {
    if (isWorkflowExecuting) return;
    const popover = document.getElementById('node-inspector-popover');
    if (!popover) return;

    currentInspectedNodeRoleId = nodeData.role_id;

    // Prevent clicks inside inspector from bubbling to document and closing itself
    if (!popover._hasStopPropagation) {
      popover.addEventListener('click', (e) => e.stopPropagation());
      popover.addEventListener('mousedown', (e) => e.stopPropagation());
      popover._hasStopPropagation = true;
    }

    const titleEl = document.getElementById('inspector-node-title');
    const statusEl = document.getElementById('inspector-save-status');
    const selectEl = document.getElementById('inspector-model-select');
    const promptEl = document.getElementById('inspector-prompt-input');
    const closeBtn = document.getElementById('inspector-close-btn');

    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    if (titleEl) titleEl.textContent = isEn ? getCompactRoleName(nodeData.role_id, nodeData.name_zh, nodeData.name_en) : (nodeData.name_zh || '综合理解与生成');
    if (statusEl) {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
      statusEl.className = 'inspector-save-status';
    }

    let statusTimer = null;
    function showSaveStatus(type) {
      if (!statusEl) return;
      clearTimeout(statusTimer);
      if (type === 'editing') {
        statusEl.style.display = 'inline-block';
        statusEl.className = 'inspector-save-status editing';
        statusEl.textContent = isEn ? '(Editing...)' : '(编辑中...)';
      } else if (type === 'saved') {
        statusEl.style.display = 'inline-block';
        statusEl.className = 'inspector-save-status saved';
        statusEl.textContent = isEn ? '✓ Staged' : '✓ 已暂存';
        statusTimer = setTimeout(() => {
          statusEl.style.display = 'none';
        }, 1600);
      }
    }

    // Populate candidate models for that role
    const allModels = [nodeData.selected_model, ...(nodeData.standby_models || [])].filter(Boolean);
    const currentModelId = window.activeChosenRoleModels?.[nodeData.role_id] || nodeData.selected_model?.model_id || '';
    if (selectEl) {
      selectEl.innerHTML = allModels.map((m, idx) => {
        const isLocal = m.inference_target === 'browser' || (m.model_id && m.model_id.startsWith('browser-'));
        const icon = isLocal ? '💻' : '☁️';
        const mLabel = isEn ? getCompactModelName(m.model_id, m.display_name) : (m.display_name || m.model_id);
        const tag = isLocal 
          ? (isEn ? 'Local 0-pt' : '本地 0点') 
          : (idx === 0 ? (isEn ? 'Recommended' : '智能推荐') : (isEn ? 'Standby' : '备选'));
        return `
          <option value="${m.model_id}" ${m.model_id === currentModelId ? 'selected' : ''}>
            ${icon} ${escapeHtml(mLabel)} (${tag})
          </option>
        `;
      }).join('');
    }

    if (promptEl) {
      promptEl.value = (window.activeCustomRolePrompts?.[nodeData.role_id] !== undefined)
        ? window.activeCustomRolePrompts[nodeData.role_id]
        : (nodeData.custom_prompt || '');
    }

    function autoSaveNodeConfig() {
      const chosenModelId = selectEl ? selectEl.value : currentModelId;
      const customPrompt = promptEl ? promptEl.value.trim() : '';

      window.activeCustomRolePrompts = window.activeCustomRolePrompts || {};
      window.activeCustomRolePrompts[nodeData.role_id] = customPrompt;
      nodeData.custom_prompt = customPrompt;

      window.activeChosenRoleModels = window.activeChosenRoleModels || {};
      window.activeChosenRoleModels[nodeData.role_id] = chosenModelId;

      const chosenModelObj = allModels.find(m => m.model_id === chosenModelId);
      if (chosenModelObj) {
        nodeData.selected_model = chosenModelObj;
        const modelLabel = document.getElementById('node-model-label-' + nodeData.role_id);
        if (modelLabel) {
          const compactMName = isEn ? getCompactModelName(chosenModelObj.model_id, chosenModelObj.display_name) : (chosenModelObj.display_name || chosenModelObj.model_id);
          const isLocal = chosenModelObj.inference_target === 'browser' || (chosenModelObj.model_id && chosenModelObj.model_id.startsWith('browser-'));
          const modelIcon = isLocal ? '💻' : '⚙️';
          modelLabel.innerHTML = `${modelIcon} ${escapeHtml(compactMName)}`;
        }
      }

      updateNodeDirtyState(nodeData.role_id);
    }

    if (selectEl) {
      selectEl.onchange = (e) => {
        e.stopPropagation();
        autoSaveNodeConfig();
        showSaveStatus('saved');
      };
    }

    if (promptEl) {
      promptEl.oninput = (e) => {
        showSaveStatus('editing');
      };
      promptEl.onblur = (e) => {
        autoSaveNodeConfig();
        showSaveStatus('saved');
      };
    }

    // Smart Viewport & Clamping Position Calculation (紧凑轻量面板)
    const cardRect = cardEl.getBoundingClientRect();
    const canvasPane = document.getElementById('workbench-canvas-pane');
    const parentRect = canvasPane ? canvasPane.getBoundingClientRect() : { top: 0, left: 0, width: 600, height: 600 };

    const popoverWidth = 310;
    const popoverHeight = 210;

    let leftPos = (cardRect.left - parentRect.left) + (cardRect.width - popoverWidth) / 2;
    leftPos = Math.max(16, Math.min(parentRect.width - popoverWidth - 16, leftPos));

    const spaceBelow = parentRect.height - (cardRect.bottom - parentRect.top);
    const spaceAbove = cardRect.top - parentRect.top;
    let topPos;

    if (spaceBelow >= popoverHeight + 15) {
      topPos = (cardRect.bottom - parentRect.top) + 10;
    } else if (spaceAbove >= popoverHeight + 15) {
      topPos = (cardRect.top - parentRect.top) - popoverHeight - 10;
    } else {
      topPos = Math.max(16, parentRect.height - popoverHeight - 16);
    }

    topPos = Math.max(16, Math.min(parentRect.height - popoverHeight - 16, topPos));

    if (window.innerWidth <= 768) {
      popover.style.left = '';
      popover.style.top = '';
    } else {
      popover.style.left = `${Math.round(leftPos)}px`;
      popover.style.top = `${Math.round(topPos)}px`;
    }
    popover.style.display = 'flex';

    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        autoSaveNodeConfig();
        popover.style.display = 'none';
        currentInspectedNodeRoleId = null;
      };
    }
  }

  // Stage 1 & 2: Chat Sending & Panic Transition
  async function sendChatMessage(reRouteOptions = {}) {
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    if (!user) {
      window.showModal(t('chat.loginRequired'), t('chat.loginToSend'), t('auth.goToLogin'), () => { window.location.href = '/login.html'; });
      return;
    }

    if (user.credits <= 0) {
      window.showZeroBalanceModal();
      return;
    }

    if (!reRouteOptions.isSwitch && isWorkflowExecuting) {
      return;
    }
    if (!reRouteOptions.isSwitch && window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.size > 0) {
      localToast(isEn ? 'Please run canvas changes first before starting a new turn' : '请先点击运行画布修改，再进行新一轮对话', 'info');
      return;
    }

    const input = document.getElementById('chat-input');
    const userText = reRouteOptions.customPrompt || input.value.trim() || window.lastUserPrompt || '';
    if (!userText && selectedFiles.length === 0) return;

    if (selectedFiles.some(f => f.uploadStatus === 'uploading')) {
      localToast(isEn ? 'Attachments are uploading, please wait...' : '附件正在上传中，请稍候...', 'info');
      return;
    }
    if (selectedFiles.some(f => f.uploadStatus === 'error')) {
      localToast(isEn ? 'Some attachments failed to upload. Please remove or retry before submitting.' : '部分附件上传失败，请移除或重新上传后再提交。', 'warning');
      return;
    }

    if (!reRouteOptions.isSwitch) {
      window.lastUserPrompt = userText;
      window.currentDagBaseSummary = window.lastRoundSummary;
    }

    // Trigger Stage 2: The "Panic" Split Transition
    setWorkflowActive(true);
    setWorkflowExecutionLocked(true);

    // Active Run ID for scoping inline telemetry to this exact conversation round
    const runId = 'run-' + Date.now();
    currentActiveRunId = runId;

    // Show Unified Control Bar (Set to 当前路由)
    const controlBar = document.getElementById('unified-control-bar') || document.getElementById('macro-workflow-bar');
    if (controlBar) controlBar.style.display = 'inline-flex';
    const macroLabel = document.getElementById('macro-label') || document.querySelector('.macro-label');
    const lockIcon = document.getElementById('macro-lock-icon');
    if (lockIcon) lockIcon.style.display = 'none';
    if (macroLabel) macroLabel.textContent = (typeof getLocale === 'function' && getLocale() === 'en') ? 'Route:' : '当前路由:';

    const messagesFlow = document.getElementById('messages-flow');

    // Resolve User Avatar
    const u = window.currentUser;
    let userAvatarHtml = '<span class="msg-avatar-initial">U</span>';
    if (u && u.avatar_url) {
      userAvatarHtml = `<img src="${escapeHtml(u.avatar_url)}" class="msg-avatar-img" alt="User">`;
    } else if (u && u.username) {
      userAvatarHtml = `<span class="msg-avatar-initial">${escapeHtml(u.username.charAt(0).toUpperCase())}</span>`;
    }

    // 1. Render User Message Row (Strict Left Aligned with Avatar & Ghost Surface)
    if (!reRouteOptions.isSwitch) {
      const userRow = document.createElement('div');
      userRow.className = 'chat-msg-row user';
      userRow.id = 'user-row-' + runId;
      
      let attachmentsHtml = '';
      if (selectedFiles.length > 0) {
        attachmentsHtml = '<div class="user-attachments-grid">' + 
          selectedFiles.map(f => {
            const sizeStr = formatFileSize(f.size);
            const isImg = f.previewUrl || (f.type && f.type.startsWith('image/')) || f.modality === 'image';
            if (isImg && f.previewUrl) {
              return `
                <div class="user-asset-card" title="${escapeHtml(f.name)} (${sizeStr})">
                  <div class="user-asset-thumb-box">
                    <img src="${escapeHtml(f.previewUrl)}" class="user-asset-thumb-img" alt="${escapeHtml(f.name)}" />
                  </div>
                  <div class="user-asset-meta-col">
                    <span class="user-asset-filename">${escapeHtml(f.name)}</span>
                    <span class="user-asset-filesize">${sizeStr}</span>
                  </div>
                </div>
              `;
            } else {
              const isPdf = (f.name || '').toLowerCase().endsWith('.pdf') || f.modality === 'pdf';
              const docIcon = isPdf ? '📄' : f.modality === 'audio' ? '🎙️' : '📎';
              return `
                <div class="user-asset-card" title="${escapeHtml(f.name)} (${sizeStr})">
                  <div class="user-asset-thumb-box is-doc">
                    <span class="user-asset-doc-icon">${docIcon}</span>
                  </div>
                  <div class="user-asset-meta-col">
                    <span class="user-asset-filename">${escapeHtml(f.name)}</span>
                    <span class="user-asset-filesize">${sizeStr}</span>
                  </div>
                </div>
              `;
            }
          }).join('') +
          '</div>';
      }

      userRow.innerHTML = `
        <div class="msg-avatar-col">
          <div class="msg-avatar-badge user-avatar-badge">${userAvatarHtml}</div>
        </div>
        <div class="msg-content-col">
          <!-- Inline Telemetry Metadata Bar (紧密排布在对应那次用户提问气泡正上方) -->
          <div class="telemetry-meta-bar" id="telemetry-bar-${runId}">
            <div class="telemetry-pill arb-telemetry-pill" id="arb-pill-${runId}">
              <span class="arb-text" id="arb-text-${runId}">${isEn ? '⌛ Routing...' : '⚡ 正在路由仲裁...'}</span>
            </div>
            <div class="telemetry-pill intent-telemetry-pill" id="intent-pill-${runId}" style="display:none;"></div>
            <div class="telemetry-pill cache-telemetry-pill" id="cache-pill-${runId}" style="display:none;">
              <span>${isEn ? '⚡ Cached · Fast-Pass' : '⚡ 节省算力: 命中直出'}</span>
            </div>
          </div>
          <!-- Ghost Surface User Bubble -->
          <div class="chat-bubble-user">
            ${attachmentsHtml}
            <div class="chat-user-text">${escapeHtml(userText)}</div>
            <div class="user-action-row">
              <button class="chat-action-btn copy-btn" title="${isEn ? 'Copy' : '复制提问'}" aria-label="${isEn ? 'Copy' : '复制'}">
                <svg class="copy-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                <svg class="check-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#10b981" stroke-width="2.5" style="display:none;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span class="btn-text">${isEn ? 'Copy' : '复制'}</span>
              </button>
            </div>
          </div>
        </div>
      `;
      messagesFlow.appendChild(userRow);
    }

    // 2. Render Assistant Message Row (Strict Left Aligned with NanoMesh Logo Avatar)
    const assistantRow = document.createElement('div');
    assistantRow.className = 'chat-msg-row assistant';
    const assistantId = 'assistant-msg-' + Date.now();
    assistantRow.id = assistantId;
    currentActiveAssistantId = assistantId;

    assistantRow.innerHTML = `
      <div class="msg-avatar-col">
        <div class="msg-avatar-badge mesh-avatar-badge" title="NanoMesh Engine">
          <span class="mesh-logo-glyph">◎</span>
        </div>
      </div>
      <div class="msg-content-col">
        <div class="chat-bubble-assistant">
          <div class="assistant-steps-stream" id="assistant-steps-${assistantId}"></div>
          <div class="chat-response-wrapper">
            <div class="chat-response-text" id="response-text-${assistantId}">
              <span style="color:var(--text-secondary); font-size:0.85rem; animation: pulseGlow 1.5s infinite;">⚡ ${isEn ? 'NanoMesh Orchestrating...' : 'NanoMesh 调度执行中...'}</span>
            </div>
            <div class="chat-response-actions" id="actions-${assistantId}">
              <button class="chat-action-btn copy-btn" title="${isEn ? 'Copy' : '复制内容'}" aria-label="${isEn ? 'Copy' : '复制'}">
                <svg class="copy-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                <svg class="check-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#10b981" stroke-width="2.5" style="display:none;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span class="btn-text">${isEn ? 'Copy' : '复制'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    messagesFlow.appendChild(assistantRow);
    const scrollContainer = document.getElementById('chat-messages');
    if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;

    // Persist attached assets into session vault and identify newly supplemented files
    window.sessionAssets = window.sessionAssets || [];
    const newlySelectedFiles = (selectedFiles && selectedFiles.length > 0) ? [...selectedFiles] : [];
    const hasNewUploads = newlySelectedFiles.length > 0;

    const resolveModality = (f) => {
      let modality = f.inMemoryText ? 'text' : f.modality;
      if (!modality) {
        const mime = (f.type || '').toLowerCase();
        if (mime.startsWith('image/')) modality = 'image';
        else if (mime.startsWith('audio/')) modality = 'audio';
        else if ((f.name || '').toLowerCase().endsWith('.pdf') || mime.includes('pdf')) modality = 'pdf';
        else modality = 'text';
      }
      return modality;
    };

    const newUploadModalities = newlySelectedFiles.map(resolveModality);

    // 1. Pre-flight Snapshot for Atomic Rollback on Fast-Failed / Error
    window._currentPreFlightSnapshot = {
      sessionAssets: JSON.parse(JSON.stringify(window.sessionAssets || [])),
      currentRoundAssets: JSON.parse(JSON.stringify(window.currentRoundAssets || [])),
      lastRoundSummary: window.lastRoundSummary,
      currentDagBaseSummary: window.currentDagBaseSummary,
      activeBranchId: window.activeBranchId || 'main',
      sessionBranches: JSON.parse(JSON.stringify(window.sessionBranches || { 'main': { branchId: 'main', isMediaBranch: false, lastValidSummary: '' } }))
    };

    // 2. Stage new files for this round (do NOT mutate window.sessionAssets until commit)
    window._currentStagedNewFiles = newlySelectedFiles.map(f => ({
      ...f,
      isNew: true,
      modality: resolveModality(f),
      introducedRound: window.chatRoundIndex + 1,
      branchId: window.activeBranchId || 'main'
    }));

    // In this round, build activeAssets list:
    // When re-running the current DAG on the canvas (isSwitch: true), isolate to current round's active assets.
    const baseAssetSource = (reRouteOptions.isSwitch && Array.isArray(window.currentRoundAssets))
      ? window.currentRoundAssets
      : (window.sessionAssets || []);

    const historicalAssets = baseAssetSource.map(f => ({
      ...f,
      isNew: false,
      modality: resolveModality(f)
    }));

    const currentAssets = reRouteOptions.isSwitch
      ? baseAssetSource.map(f => ({ ...f, modality: resolveModality(f) }))
      : [...historicalAssets, ...window._currentStagedNewFiles];

    // Snapshot assets for current dialogue round persistence
    window.currentRoundAssets = currentAssets.map(f => ({
      name: f.name || 'attachment',
      size: f.size || 0,
      type: f.type || '',
      modality: f.modality,
      assetId: f.assetId,
      r2Key: f.r2Key,
      previewUrl: f.previewUrl || '',
      inMemoryText: f.inMemoryText,
      isNew: !!f.isNew
    }));

    window.activeRoundPayload = {
      prompt: userText,
      files: [...window.currentRoundAssets]
    };

    if (!reRouteOptions.isSwitch) {
      input.value = '';
      input.style.height = 'auto';
      selectedFiles = [];
      renderFileChips();
    }

    // Build Session Asset Ledger
    const sessionAssetLedger = (window.sessionAssets || []).map(a => ({
      asset_id: a.assetId || a.name,
      filename: a.name || 'attachment',
      modality: a.modality || resolveModality(a),
      introduced_round: a.introducedRound || 1,
      branch_id: a.branchId || 'main'
    }));

    // Retrieve active branch context & construct Branch Catalog
    const hasMediaAnywhere = (window.sessionAssets || []).some(a => {
      const m = resolveModality(a);
      return m === 'image' || m === 'audio' || m === 'pdf';
    });
    window.sessionBranches = window.sessionBranches || { 'main': { branchId: 'main', topic: hasMediaAnywhere ? '多模态媒体分析' : '初始任务', isMediaBranch: hasMediaAnywhere, lastValidSummary: '', assetIds: [] } };
    if (window.sessionBranches['main'] && hasMediaAnywhere && !window.sessionBranches['branch_media']) {
      window.sessionBranches['main'].isMediaBranch = true;
      if (window.sessionBranches['main'].topic === '初始任务' || window.sessionBranches['main'].topic === '常规任务对话') {
        window.sessionBranches['main'].topic = '多模态媒体分析';
      }
    }
    window.activeBranchId = window.activeBranchId || 'main';
    const activeBranch = window.sessionBranches[window.activeBranchId];
    const activeBranchSummary = (activeBranch && activeBranch.lastValidSummary)
      || window.currentDagBaseSummary
      || window.lastRoundSummary
      || undefined;

    const branchCatalog = Object.values(window.sessionBranches || {}).map(b => ({
      branch_id: b.branchId,
      topic: b.topic || (b.isMediaBranch ? '多模态媒体分析' : '常规任务对话'),
      is_media: !!b.isMediaBranch,
      last_summary: b.lastValidSummary || '',
      is_active: b.branchId === (window.activeBranchId || 'main')
    }));

    // Build Unified Protocol Envelope
    const envelope = {
      envelope_id: crypto.randomUUID(),
      session_id: window.chatSessionId,
      round_index: ++window.chatRoundIndex,
      instruction_payload: userText,
      assets_manifest: currentAssets.map(f => ({
        asset_id: f.assetId || crypto.randomUUID(),
        modality: f.modality,
        mime_type: f.type || 'text/plain',
        file_size: f.size || 0,
        r2_key: f.r2Key || null,
        in_memory_text: f.inMemoryText || null,
        in_memory_data: null,
        consumed: false,
        source_digest: f.r2Key || (f.name + '-' + (f.inMemoryText ? f.inMemoryText.length : f.size)),
        is_new: !!f.isNew,
        filename: f.name || 'attachment'
      })),
      constraint_context: {
        target_language: localStorage.getItem('nanomesh_lang') || 'auto',
        output_style: localStorage.getItem('nanomesh_style') || 'concise'
      },
      metadata: {
        client_timestamp: Date.now(),
        char_count_total: userText.length,
        estimated_input_tokens: Math.ceil(userText.length / 2) + 200,
        has_new_upload: hasNewUploads,
        new_upload_count: newlySelectedFiles.length,
        new_upload_modalities: newUploadModalities
      }
    };

    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = true;

    // Abort previous running stream if switching
    if (window.activeChatAbortController) {
      try { window.activeChatAbortController.abort(); } catch (e) {}
    }
    window.activeChatAbortController = new AbortController();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: window.activeChatAbortController.signal,
        body: JSON.stringify({
          envelope,
          disableBrowserInference: !!window.disableLocalInference,
          reRouteMode: reRouteOptions.reRouteMode || 'normal',
          chosenTemplateId: reRouteOptions.chosenTemplateId || (reRouteOptions.isSwitch ? window.currentRunningTemplateId : undefined),
          chosenRoleModels: reRouteOptions.chosenRoleModels || (reRouteOptions.isSwitch ? window.activeChosenRoleModels : undefined),
          customRolePrompts: reRouteOptions.customRolePrompts || (reRouteOptions.isSwitch ? window.activeCustomRolePrompts : undefined),
          customNodePrompt: reRouteOptions.customNodePrompt,
          hasPreviousRound: !!(window.currentDagBaseSummary || window.lastRoundSummary),
          previousRoundSummary: (window.currentDagBaseSummary || window.lastRoundSummary) || undefined,
          hadMediaAssets: (window.sessionAssets || []).some(a => {
            const m = resolveModality(a);
            return m === 'image' || m === 'audio' || m === 'pdf';
          }),
          hasNewUploads,
          newUploadModalities,
          sessionAssetLedger,
          activeBranchId: window.activeBranchId,
          activeBranchSummary,
          branchCatalog
        })
      });

      if (res.status === 403) {
        window.showZeroBalanceModal();
        assistantRow.remove();
        sendBtn.disabled = false;
        return;
      }

      if (res.status === 429) {
        const rateLimitData = await res.json().catch(() => ({}));
        const retryAfter = rateLimitData.retry_after || 5;
        if (typeof window.showRateLimitModal === 'function') {
          window.showRateLimitModal(retryAfter, rateLimitData.message);
        } else {
          alert(rateLimitData.message || `请求过于频繁，请稍候 ${retryAfter} 秒后再试`);
        }
        // Restore user prompt in chat input so input text is not lost
        const inputEl = document.getElementById('chat-input');
        if (inputEl && !inputEl.value.trim() && userText) {
          inputEl.value = userText;
          inputEl.style.height = 'auto';
        }
        assistantRow.remove();
        sendBtn.disabled = false;
        return;
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || '调度失败');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullOutput = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep last incomplete line

        let currentEvent = 'message';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (currentEvent === 'text_chunk' && data.chunk) {
                fullOutput += data.chunk;
              } else if (currentEvent === 'dag_complete' && data.final_output) {
                fullOutput = data.final_output;
              }
              handleSSEMessage(currentEvent, data, assistantId, userText);
            } catch (parseErr) {}
          }
        }
      }

      // Await in-browser local execution if dispatched
      if (window._activeLocalRunnerPromise) {
        try {
          const clientOutput = await window._activeLocalRunnerPromise;
          if (clientOutput) fullOutput = clientOutput;
        } catch (clientErr) {
          console.error('Local runner execution error:', clientErr);
        } finally {
          window._activeLocalRunnerPromise = null;
        }
      }

      if (fullOutput && !window._isCurrentTurnRolledBack) {
        window.lastRoundSummary = fullOutput.slice(0, 4000);
      }
      window.lastHadMedia = (window.sessionAssets || []).some(a => {
        const m = a.modality || (a.type && a.type.startsWith('image/') ? 'image' : (a.type && a.type.startsWith('audio/') ? 'audio' : ''));
        return m === 'image' || m === 'audio';
      });

    } catch (err) {
      if (window._currentPreFlightSnapshot) {
        window.sessionAssets = window._currentPreFlightSnapshot.sessionAssets;
        window.currentRoundAssets = window._currentPreFlightSnapshot.currentRoundAssets;
        window.lastRoundSummary = window._currentPreFlightSnapshot.lastRoundSummary;
        window.currentDagBaseSummary = window._currentPreFlightSnapshot.currentDagBaseSummary;
        window.activeBranchId = window._currentPreFlightSnapshot.activeBranchId;
        window.sessionBranches = window._currentPreFlightSnapshot.sessionBranches;
      }
      window._currentStagedNewFiles = [];
      setWorkflowExecutionLocked(false);
      if (streamingRafMap.has(assistantId)) {
        cancelAnimationFrame(streamingRafMap.get(assistantId));
        streamingRafMap.delete(assistantId);
      }
      streamingTextBuffers.delete(assistantId);
      if (err.name === 'AbortError') return;
      console.error('Chat stream error:', err);
      const respEl = document.getElementById('response-text-' + assistantId);
      if (respEl) {
        respEl.innerHTML = `<span style="color:var(--error-color)">❌ 任务调度失败: ${escapeHtml(err.message)}</span>`;
      }
    } finally {
      sendBtn.disabled = false;
      setWorkflowExecutionLocked(false);
      if (typeof fetchUserData === 'function') fetchUserData();
    }
  }

  // --- Virtual Closure Patch for Streaming Markdown & Smart Auto-Scroll ---
  function patchUnclosedMarkdown(raw) {
    if (!raw) return '';
    let patched = raw;

    // 1. Check code blocks with triple backticks ```
    const codeBlockMatches = patched.match(/```/g);
    const codeBlockCount = codeBlockMatches ? codeBlockMatches.length : 0;
    if (codeBlockCount % 2 === 1) {
      return patched + '\n```';
    }

    // 2. Check inline code backticks ` (outside code blocks)
    const inlineTicks = patched.match(/(?<!`)`(?!`)/g);
    if (inlineTicks && inlineTicks.length % 2 === 1) {
      patched += '`';
    }

    // 3. Check bold syntax **
    const boldMatches = patched.match(/\*\*/g);
    if (boldMatches && boldMatches.length % 2 === 1) {
      patched += '**';
    }

    // 4. Check strikethrough ~~
    const strikeMatches = patched.match(/~~/g);
    if (strikeMatches && strikeMatches.length % 2 === 1) {
      patched += '~~';
    }

    return patched;
  }

  function smartScrollToBottom(scrollContainer) {
    if (!scrollContainer) return;
    const distanceToBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    // Smart auto-scroll: pin to bottom unless user has manually scrolled up > 90px
    if (distanceToBottom <= 90) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  const streamingTextBuffers = new Map();
  const streamingRafMap = new Map();

  function scheduleStreamingMarkdownRender(assistantId) {
    if (streamingRafMap.has(assistantId)) return;

    const rafId = requestAnimationFrame(() => {
      streamingRafMap.delete(assistantId);
      const respEl = document.getElementById('response-text-' + assistantId);
      if (!respEl) return;

      const rawText = sanitizePromptLeakage(streamingTextBuffers.get(assistantId) || '');
      if (!rawText) return;

      const patched = patchUnclosedMarkdown(rawText);
      const parsed = safeRenderMarkdown(patched);

      if (parsed.includes('</p>')) {
        respEl.innerHTML = parsed.replace(/<\/p>(\s*)$/, '<span class="streaming-cursor"></span></p>$1');
      } else {
        respEl.innerHTML = parsed + '<span class="streaming-cursor"></span>';
      }

      smartScrollToBottom(document.getElementById('chat-messages'));
    });

    streamingRafMap.set(assistantId, rafId);
  }

  // Stage 3 & 4: SSE Message Dispatcher & DAG State Synchronization
  function handleSSEMessage(event, data, assistantId, userPrompt = '') {
    const respEl = document.getElementById('response-text-' + assistantId);
    const arbPill = document.getElementById('arbitration-pill');
    const arbText = document.getElementById('arb-text');

    if (event === 'dag_plan') {
      activeDagNodes = (data.nodes || []).map(n => {
        if (window.activeCustomRolePrompts && window.activeCustomRolePrompts[n.role_id] !== undefined) {
          n.custom_prompt = window.activeCustomRolePrompts[n.role_id];
        }
        return n;
      });
      currentCandidateTemplates = data.candidate_templates || [];
      window.currentRunningTemplateId = data.template?.template_id;
      window.currentRunningTemplateObj = data.template || null;
      window.currentRoundIntentState = data.reasoning_trace?.intent_state || null;

      const isFirewall = !!data.is_security_violation;
      const isUnreachable = !!data.is_unreachable;
      const isEn = getLocale() === 'en';

      // Record baseline executed configuration for each node & persist model IDs
      window.originalNodeConfigs = {};
      window.activeChosenRoleModels = window.activeChosenRoleModels || {};
      (data.nodes || []).forEach(n => {
        window.originalNodeConfigs[n.role_id] = {
          model_id: n.selected_model.model_id,
          custom_prompt: n.custom_prompt || ''
        };
        window.activeChosenRoleModels[n.role_id] = n.selected_model.model_id;
      });
      if (window.pendingModifiedRoleIds) {
        window.pendingModifiedRoleIds.clear();
      }
      updateRerouteButtonState();

      // 1. Lock arbitration feedback pill (Stage 2)
      const currentArbPill = (currentActiveRunId && document.getElementById('arb-pill-' + currentActiveRunId)) || arbPill;
      const currentArbText = (currentActiveRunId && document.getElementById('arb-text-' + currentActiveRunId)) || arbText;
      if (currentArbPill) currentArbPill.classList.add('locked');
      const latency = data.reasoning_trace?.duration_ms || Math.floor(Math.random() * 80 + 130);
      if (currentArbText) {
        currentArbText.textContent = getCompactArbitrationText(isFirewall, isUnreachable, latency, isEn);
      }

      // 2. Intent Tracking (Step 5 mapping: State A, B, C)
      const currentIntentPill = (currentActiveRunId && document.getElementById('intent-pill-' + currentActiveRunId)) || document.getElementById('intent-pill');
      const isMultiRound = Boolean(data.reasoning_trace?.is_multi_round && data.reasoning_trace?.intent_state);
      const intentState = data.reasoning_trace?.intent_state;
      const targetBranchId = data.reasoning_trace?.target_branch_id;
      if (intentState === 'SWITCH_BRANCH' && targetBranchId) {
        window.activeBranchId = targetBranchId;
      }

      if (currentIntentPill) {
        if (!isMultiRound || !intentState || isFirewall) {
          currentIntentPill.style.display = 'none';
        } else {
          currentIntentPill.style.display = 'inline-flex';
          const compactIntent = getCompactIntentName(intentState, isEn);
          const stateClass = intentState === 'ANCHOR_TAIL' ? 'state-a' :
            intentState === 'REBIND_ROOT' ? 'state-b' :
            intentState === 'CROSS_FUSION' ? 'state-d' :
            intentState === 'SWITCH_BRANCH' ? 'state-e' : 'state-c';
          const titleText = isEn 
            ? (intentState === 'ANCHOR_TAIL' ? 'State A: Stripped raw media, inheriting prior turn text context' :
               intentState === 'REBIND_ROOT' ? 'State B: Reset asset pointer, re-exploring raw media assets' :
               intentState === 'CROSS_FUSION' ? 'State D: Cross-turn asset fusion and comparison' :
               intentState === 'SWITCH_BRANCH' ? 'State E: Switched context to recalled historical task branch' :
               'State C: Detached historical context, independent clean orchestration')
            : (intentState === 'ANCHOR_TAIL' ? '状态 A：已剥离原始媒体资产，装载上轮产物，精简重组文本润色图' :
               intentState === 'REBIND_ROOT' ? '状态 B：重置资产指针，全链路重新探索原始素材' :
               intentState === 'CROSS_FUSION' ? '状态 D：多源融合与跨轮对比，继承历史资产并结合新输入' :
               intentState === 'SWITCH_BRANCH' ? '状态 E：已切回关联的历史任务分支，挂载该分支产物为基底' :
               '状态 C：断离历史上下文，全新任务独立编排');
          currentIntentPill.className = `telemetry-pill intent-telemetry-pill ${stateClass}`;
          currentIntentPill.textContent = compactIntent;
          currentIntentPill.title = titleText;
        }
      }

      // 3. Macro Route Switcher (Step 2 Mapping)
      const routeChain = document.getElementById('macro-route-chain');
      const macroDropdown = document.getElementById('macro-dropdown');
      const macroCapsuleBtn = document.getElementById('macro-capsule-btn');
      const macroLabel = document.getElementById('macro-label') || document.querySelector('.macro-label');
      const lockIcon = document.getElementById('macro-lock-icon');

      if (macroLabel) {
        macroLabel.textContent = isEn ? 'Route:' : '当前路由:';
      }
      if (lockIcon) {
        lockIcon.style.display = 'none';
      }

      if (routeChain && data.nodes) {
        if (isFirewall) {
          routeChain.textContent = isEn ? '🛡️ Edge Firewall (Blocked)' : '🛡️ 边界防御网关 (已拦截)';
        } else if (isUnreachable) {
          routeChain.textContent = isEn ? '∅ Unreachable (No Matching Pipeline)' : '∅ 意图不可达 (未匹配到流水线)';
        } else {
          routeChain.textContent = data.nodes.map(n => getCompactRoleName(n.role_id, n.name_zh, n.name_en)).join(' ➔ ');
        }
      }

      if (macroCapsuleBtn) {
        if (isFirewall || isUnreachable) {
          macroCapsuleBtn.style.pointerEvents = 'none';
          macroCapsuleBtn.style.opacity = '0.6';
        } else {
          macroCapsuleBtn.style.pointerEvents = '';
          macroCapsuleBtn.style.opacity = '1';
        }
      }

      if (macroCapsuleBtn && macroDropdown && currentCandidateTemplates.length > 0 && !isFirewall && !isUnreachable) {
        macroCapsuleBtn.onclick = (e) => {
          e.stopPropagation();
          if (isWorkflowExecuting) return;
          macroDropdown.style.display = macroDropdown.style.display === 'none' ? 'block' : 'none';
        };

        macroDropdown.innerHTML = currentCandidateTemplates.map((t, idx) => {
          const tplTitle = isEn 
            ? `${idx === 0 ? '🏆' : (idx === 1 ? '⚡' : '🔍')} Route ${idx + 1}: ${escapeHtml(getCompactTemplateName(t.template_id, t.name_zh, t.name_en))}`
            : `${idx === 0 ? '🏆' : (idx === 1 ? '⚡' : '🔍')} 路线 ${idx + 1}: ${escapeHtml(t.name_zh)}`;
          const tplDesc = isEn
            ? (idx === 0 ? 'Optimal match · Recommended' : (idx === 1 ? 'Cost saver · Save 40% ⚡' : 'Low latency direct route'))
            : (idx === 0 ? '综合胜任度最高 · 智能推荐' : (idx === 1 ? '更省算力 · 预估节省 40% ⚡' : '低时延直出路线'));
          return `
            <div class="macro-dropdown-item ${t.template_id === data.template?.template_id ? 'active' : ''}" data-tpl-id="${t.template_id}">
              <div style="font-weight:600; font-size:0.85rem; color:var(--text-primary);">
                ${tplTitle}
              </div>
              <div style="font-size:0.74rem; color:var(--text-secondary); margin-top:2px;">
                ${tplDesc}
              </div>
            </div>
          `;
        }).join('');

        macroDropdown.querySelectorAll('.macro-dropdown-item').forEach(item => {
          item.onclick = (e) => {
            e.stopPropagation();
            if (isWorkflowExecuting) return;
            const chosenId = item.getAttribute('data-tpl-id');
            macroDropdown.style.display = 'none';
            if (chosenId !== data.template?.template_id) {
              if (window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.size > 0) {
                const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
                const msg = isEn 
                  ? 'Switching workflow routes will discard unsaved node modifications. Proceed?' 
                  : '切换工作流路线将放弃当前节点未应用的微调，是否确认切换？';
                if (!confirm(msg)) return;
                window.pendingModifiedRoleIds.clear();
                window.activeCustomRolePrompts = {};
                updateRerouteButtonState();
              }
              sendChatMessage({
                isSwitch: true,
                reRouteMode: 'switch_template',
                chosenTemplateId: chosenId,
                customPrompt: userPrompt || '切换工作流'
              });
            }
          };
        });
      }

      // 4. Render Left 65% Whitebox DAG Nodes with Anchors & Receipts
      const intentStateVal = data.reasoning_trace?.intent_state || null;
      window.currentRoundIntentState = intentStateVal;

      let activeAssets = (window.activeRoundPayload && window.activeRoundPayload.files) || [];

      if (intentStateVal === 'ANCHOR_TAIL') {
        window.stateAConsecutiveCount = (window.stateAConsecutiveCount || 0) + 1;
        // Keep only text/document assets (0 image tokens)
        activeAssets = activeAssets.filter(a => a.modality === 'text' || a.modality === 'text_doc' || (a.name && (a.name.endsWith('.txt') || a.name.endsWith('.md'))));
        if (window.activeRoundPayload) window.activeRoundPayload.files = activeAssets;
        window.currentRoundAssets = activeAssets;
      } else if (intentStateVal === 'DETACH_RESET') {
        window.stateAConsecutiveCount = 0;
        window.isStackExpanded = false;
        // In Detach / Reset, if newly uploaded assets exist, isolate them; otherwise force empty for Net Envelope
        const newAssets = activeAssets.filter(a => a.isNew);
        if (newAssets.length > 0) {
          activeAssets = newAssets;
        } else {
          activeAssets = [];
        }
        if (window.activeRoundPayload) window.activeRoundPayload.files = activeAssets;
        window.currentRoundAssets = activeAssets;
      } else if (intentStateVal === 'CROSS_FUSION') {
        window.stateAConsecutiveCount = 0;
        window.isStackExpanded = false;
        if (window.activeRoundPayload) window.activeRoundPayload.files = activeAssets;
        window.currentRoundAssets = activeAssets;
      } else {
        // REBIND_ROOT
        window.stateAConsecutiveCount = 0;
        window.isStackExpanded = false;
        if (window.activeRoundPayload) window.activeRoundPayload.files = activeAssets;
        window.currentRoundAssets = activeAssets;
      }

      renderDagNodesWithAnchors(data.nodes || [], {
        isFirewall,
        isUnreachable,
        intentState: intentStateVal,
        prompt: userPrompt || window.lastUserPrompt || '',
        assets: activeAssets,
        doSweep: intentStateVal === 'DETACH_RESET'
      });

      // Clear response text placeholder
      if (respEl) {
        respEl.innerHTML = '';
      }
    } else if (event === 'node_start') {
      const isEn = getLocale() === 'en';
      const nodeCard = document.getElementById('dag-node-' + data.role_id);
      const meta = document.getElementById('node-meta-' + data.role_id);
      if (nodeCard) {
        nodeCard.classList.remove('cached', 'completed');
        const oldStamp = nodeCard.querySelector('.dag-cache-hit-stamp');
        if (oldStamp) oldStamp.remove();
        if (data.inference_target === 'browser') {
          nodeCard.classList.add('is-downloading');
          let progressBar = nodeCard.querySelector('.dag-card-progress-bar');
          if (!progressBar) {
            progressBar = document.createElement('div');
            progressBar.className = 'dag-card-progress-bar';
            progressBar.style.width = '0%';
            nodeCard.appendChild(progressBar);
          }
        } else {
          nodeCard.classList.add('running');
        }
      }
      if (meta) {
        meta.textContent = data.inference_target === 'browser'
          ? (isEn ? '📥 Fetching weights...' : '📥 准备权重...')
          : (isEn ? 'Running...' : '执行中...');
      }
      requestAnimationFrame(() => renderDagSvgConnectors());

      // Render Step Indicator Badge (状态步进与内容分离: ⠋ 视觉元素提取中...)
      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        let stepBadge = document.getElementById('step-badge-' + currentActiveAssistantId + '-' + data.role_id);
        const roleName = isEn 
          ? (data.role_name_en || getCompactRoleName(data.role_id, data.role_name)) 
          : (data.role_name || (activeDagNodes.find(n => n.role_id === data.role_id)?.name_zh) || '处理');
        if (!stepBadge) {
          stepBadge = document.createElement('div');
          stepBadge.className = 'assistant-step-badge running';
          stepBadge.id = 'step-badge-' + currentActiveAssistantId + '-' + data.role_id;
          stepsContainer.appendChild(stepBadge);
        }
        stepBadge.innerHTML = `<span class="step-spinner">⠋</span> <span>${escapeHtml(roleName)} ${isEn ? 'Processing...' : '执行中...'}</span>`;
      }
    } else if (event === 'client_exec_request') {
      const isEn = getLocale() === 'en';
      const roleId = data.role_id;
      const modelName = data.model_name || 'SmolLM2-135M 本地极速';
      const nodeCard = document.getElementById('dag-node-' + roleId);
      const meta = document.getElementById('node-meta-' + roleId);

      // 1. Right 35% Chat Flow: Immediate System Preflight Diagnostics Log below user bubble
      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        let diagEl = document.getElementById('preflight-diag-' + currentActiveAssistantId);
        if (!diagEl) {
          diagEl = document.createElement('div');
          diagEl.id = 'preflight-diag-' + currentActiveAssistantId;
          diagEl.className = 'system-preflight-diagnostics';
          diagEl.innerHTML = `
            <div class="preflight-title">⚡ [NanoMesh Client-Side Dispatcher]</div>
            <div class="preflight-line">✓ ${isEn ? 'Cloud JEV Arbitration Passed: Template & Safety Verified' : '云端 JEV 意图仲裁通过: 模板与安全核准'}</div>
            <div class="preflight-line">✓ ${isEn ? 'Assigned In-Browser Compute' : '指派端侧本地算力'}: ${escapeHtml(modelName)}</div>
            <div class="preflight-line" id="diag-worker-status-${currentActiveAssistantId}">⚙️ ${isEn ? 'Initializing WebGPU sandbox (Transformers.js)...' : '初始化 WebGPU 推理沙箱 (Transformers.js)...'}</div>
          `;
          stepsContainer.parentNode.insertBefore(diagEl, stepsContainer);
        }
      }

      // 2. Step Badge in right chat flow
      if (stepsContainer) {
        let stepBadge = document.getElementById('step-badge-' + currentActiveAssistantId + '-' + roleId);
        if (!stepBadge) {
          stepBadge = document.createElement('div');
          stepBadge.className = 'assistant-step-badge running';
          stepBadge.id = 'step-badge-' + currentActiveAssistantId + '-' + roleId;
          stepsContainer.appendChild(stepBadge);
        }
        stepBadge.innerHTML = `<span class="step-spinner">⠋</span> <span>${escapeHtml(modelName)} ${isEn ? 'Local Inference...' : '本地推理中...'}</span>`;
      }

      // 3. Canvas Node Card: is-downloading state and 1.5px pulse progress bar
      if (nodeCard) {
        nodeCard.classList.remove('running', 'completed', 'cached');
        nodeCard.classList.add('is-downloading');

        let progressBar = nodeCard.querySelector('.dag-card-progress-bar');
        if (!progressBar) {
          progressBar = document.createElement('div');
          progressBar.className = 'dag-card-progress-bar';
          progressBar.style.width = '0%';
          nodeCard.appendChild(progressBar);
        }
      }
      if (meta) {
        meta.textContent = isEn ? '📥 Fetching weights...' : '📥 准备权重...';
      }
      requestAnimationFrame(() => renderDagSvgConnectors());

      // 4. Dedicated Web Worker Execution
      window._activeLocalRunnerPromise = new Promise((resolve, reject) => {
        try {
          if (!window._localWorker) {
            window._localWorker = new Worker('/local-runner.js', { type: 'module' });
          }
          const worker = window._localWorker;

          worker.onerror = (err) => {
            console.error('[LocalRunner] Worker thread error:', err);
            const meta = document.getElementById('node-meta-' + roleId);
            if (meta) meta.textContent = '❌ 本地推理异常';
            const workerDiag = document.getElementById('diag-worker-status-' + currentActiveAssistantId);
            if (workerDiag) workerDiag.textContent = `❌ ${escapeHtml(err.message || 'Worker thread execution error')}`;
            setWorkflowExecutionLocked(false);
            const sendBtn = document.getElementById('send-btn');
            if (sendBtn) sendBtn.disabled = false;
            reject(new Error(err.message || 'Local worker crashed'));
          };

          worker.onmessage = (e) => {
            const msg = e.data || {};
            const workerDiag = document.getElementById('diag-worker-status-' + currentActiveAssistantId);

            if (msg.type === 'DOWNLOAD_PROGRESS') {
              if (meta) {
                meta.textContent = `📥 拉取权重 ${msg.loadedMB}/${msg.totalMB}MB (${msg.speedMBps} MB/s)`;
              }
              const pBar = nodeCard?.querySelector('.dag-card-progress-bar');
              if (pBar) {
                pBar.classList.remove('is-compiling');
                pBar.style.width = `${msg.percent}%`;
              }
              if (workerDiag) {
                workerDiag.textContent = `📥 ${isEn ? 'Pulling Weights' : '拉取权重'}: ${msg.loadedMB}/${msg.totalMB}MB (${msg.percent}%) @ ${msg.speedMBps} MB/s`;
              }
            } else if (msg.type === 'COMPILING_PIPELINE') {
              const devName = msg.device === 'webgpu' ? 'WebGPU' : 'Wasm CPU';
              if (meta) {
                meta.textContent = `⚙️ 正在编译 ${devName} 管线... (${msg.duration_ms || 32}ms)`;
              }
              const pBar = nodeCard?.querySelector('.dag-card-progress-bar');
              if (pBar) {
                pBar.classList.add('is-compiling');
                pBar.style.width = '100%';
              }
              if (workerDiag) {
                workerDiag.textContent = `⚙️ ${isEn ? `Compiling ${devName} Pipeline...` : `正在编译 ${devName} 计算管线...`} (${msg.duration_ms || 32}ms)`;
              }
            } else if (msg.type === 'TEXT_CHUNK') {
              // Transition to Local running
              if (nodeCard) {
                nodeCard.classList.remove('is-downloading');
                nodeCard.classList.add('running');
              }
              if (meta && !meta.textContent.includes('💻')) {
                meta.textContent = isEn ? '💻 Local Ready' : '💻 Local 就绪';
              }
              const pBar = nodeCard?.querySelector('.dag-card-progress-bar');
              if (pBar) {
                pBar.style.opacity = '0';
                setTimeout(() => pBar.remove(), 300);
              }
              if (workerDiag && !workerDiag.textContent.includes('✓ 管线就绪')) {
                const devName = msg.device === 'webgpu' ? 'WebGPU' : 'Wasm CPU';
                workerDiag.textContent = `✓ ${isEn ? `${devName} pipeline ready, streaming...` : `${devName} 管线就绪，正在高速流式推理...`}`;
              }

              // Append streamed chunk
              const rawChunk = msg.chunk || '';
              const prev = streamingTextBuffers.get(assistantId) || '';
              streamingTextBuffers.set(assistantId, prev + rawChunk);
              scheduleStreamingMarkdownRender(assistantId);

            } else if (msg.type === 'GENERATE_COMPLETE') {
              // Complete execution
              if (nodeCard) {
                nodeCard.classList.remove('is-downloading', 'running');
                nodeCard.classList.add('completed');
              }
              if (meta) {
                meta.textContent = `⚡ 本地 ${msg.duration_ms}ms`;
              }

              // Step badge completed
              if (stepsContainer) {
                let stepBadge = document.getElementById('step-badge-' + currentActiveAssistantId + '-' + roleId);
                if (stepBadge) {
                  stepBadge.className = 'assistant-step-badge completed';
                  stepBadge.innerHTML = `<span class="step-check">✓</span> <span>${escapeHtml(modelName)} ${isEn ? 'Done' : '完成'}</span> <span class="step-time">⚡ 0点 · ${msg.duration_ms}ms</span>`;
                }
              }

              if (workerDiag) {
                workerDiag.textContent = `✓ ${isEn ? 'Local Inference Completed' : '本地端侧推理完成'} (${msg.duration_ms}ms · ⚡ 0点)`;
              }

              // Mark Sink Anchor completed
              const sink = document.getElementById('dag-sink-anchor');
              if (sink) {
                sink.classList.remove('is-executing');
                sink.classList.add('completed');
              }
              requestAnimationFrame(() => renderDagSvgConnectors());

              // Finalize markdown render
              const fullText = msg.output || streamingTextBuffers.get(assistantId) || '';
              if (respEl) {
                respEl.innerHTML = safeRenderMarkdown(fullText);
              }
              if (streamingRafMap.has(assistantId)) {
                cancelAnimationFrame(streamingRafMap.get(assistantId));
                streamingRafMap.delete(assistantId);
              }
              streamingTextBuffers.delete(assistantId);

              // Reveal copy and action buttons
              const actionsEl = document.getElementById('actions-' + assistantId);
              if (actionsEl) {
                actionsEl.style.display = 'flex';
                actionsEl.classList.add('is-visible');
              }

              setWorkflowExecutionLocked(false);
              const sendBtn = document.getElementById('send-btn');
              if (sendBtn) sendBtn.disabled = false;

              resolve(fullText);
            } else if (msg.type === 'ERROR') {
              if (nodeCard) nodeCard.classList.remove('is-downloading', 'running');
              if (meta) meta.textContent = '❌ 本地推理异常';
              if (workerDiag) workerDiag.textContent = `❌ ${escapeHtml(msg.error)}`;
              // Clear partially streamed text buffer if error occurred during generation
              if (respEl) {
                streamingTextBuffers.delete(assistantId);
                respEl.innerHTML = `<span style="color:var(--color-danger, #ef4444);font-size:13px;">❌ ${escapeHtml(msg.error)}</span>`;
              }
              setWorkflowExecutionLocked(false);
              const sendBtn = document.getElementById('send-btn');
              if (sendBtn) sendBtn.disabled = false;
              reject(new Error(msg.error || 'Local execution failed'));
            }
          };

          // Post generation command to worker
          worker.postMessage({
            type: 'GENERATE',
            payload: {
              role_id: data.role_id,
              model_id: data.model_id,
              endpoint: data.endpoint,
              system_prompt: data.system_prompt,
              user_prompt: data.user_prompt
            }
          });
        } catch (workerErr) {
          reject(workerErr);
        }
      });
    } else if (event === 'text_chunk') {
      const rawChunk = data.chunk || '';
      const cleanChunk = rawChunk.replace(/【执行输出】\s*/g, '');
      const prev = streamingTextBuffers.get(assistantId) || '';
      streamingTextBuffers.set(assistantId, prev + cleanChunk);

      scheduleStreamingMarkdownRender(assistantId);

      if (data.cache_hit) {
        const runCachePill = (currentActiveRunId && document.getElementById('cache-pill-' + currentActiveRunId)) || document.getElementById('cache-stream-pill');
        if (runCachePill) runCachePill.style.display = 'inline-flex';
      }
    } else if (event === 'node_complete') {
      const isEn = getLocale() === 'en';
      const nodeCard = document.getElementById('dag-node-' + data.role_id);
      const meta = document.getElementById('node-meta-' + data.role_id);
      if (nodeCard) {
        nodeCard.classList.remove('running');
        const oldStamp = nodeCard.querySelector('.dag-cache-hit-stamp');
        if (oldStamp) oldStamp.remove();
        nodeCard.classList.remove('cached', 'completed');

        if (data.cache_hit) {
          nodeCard.classList.add('cached');
          const stamp = document.createElement('span');
          stamp.className = 'dag-cache-hit-stamp';
          stamp.textContent = '⚡ HIT';
          nodeCard.appendChild(stamp);
        } else {
          nodeCard.classList.add('completed');
        }
      }
      if (meta) {
        meta.textContent = data.cache_hit ? '⚡ 0ms' : `${data.duration_ms}ms`;
      }
      requestAnimationFrame(() => renderDagSvgConnectors());

      // Record metrics into activeDagNodes
      const completedNode = activeDagNodes.find(n => n.role_id === data.role_id);
      if (completedNode) {
        completedNode.duration_ms = data.duration_ms;
        completedNode.cache_hit = !!data.cache_hit;
        if (data.output) completedNode.output = data.output;
      }

      // Update Step Indicator Badge (浅灰色 ✓ 提取完成 227ms)
      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        let stepBadge = document.getElementById('step-badge-' + currentActiveAssistantId + '-' + data.role_id);
        const roleName = isEn 
          ? (data.role_name_en || getCompactRoleName(data.role_id, data.role_name)) 
          : (data.role_name || (activeDagNodes.find(n => n.role_id === data.role_id)?.name_zh) || '节点');
        const timeStr = data.cache_hit ? '⚡ 0ms' : `${data.duration_ms}ms`;
        if (!stepBadge) {
          stepBadge = document.createElement('div');
          stepBadge.id = 'step-badge-' + currentActiveAssistantId + '-' + data.role_id;
          stepsContainer.appendChild(stepBadge);
        }
        stepBadge.className = 'assistant-step-badge completed';
        stepBadge.innerHTML = `<span class="step-check">✓</span> <span>${escapeHtml(roleName)} ${isEn ? 'Done' : '完成'}</span> <span class="step-time">${timeStr}</span>`;
      }
    } else if (event === 'security_blocked') {
      if (streamingRafMap.has(assistantId)) {
        cancelAnimationFrame(streamingRafMap.get(assistantId));
        streamingRafMap.delete(assistantId);
      }
      streamingTextBuffers.delete(assistantId);

      const isEn = getLocale() === 'en';
      const duration = data.duration_ms || 24;

      const currentArbPill = (currentActiveRunId && document.getElementById('arb-pill-' + currentActiveRunId)) || arbPill;
      const currentArbText = (currentActiveRunId && document.getElementById('arb-text-' + currentActiveRunId)) || arbText;
      if (currentArbPill) {
        currentArbPill.className = 'telemetry-pill arb-telemetry-pill locked';
        currentArbPill.style.borderColor = '#f59e0b';
        currentArbPill.style.color = '#f59e0b';
      }
      if (currentArbText) {
        currentArbText.textContent = isEn
          ? `🛑 Edge Firewall: Policy Violation Intercepted (${duration}ms · Terminated)`
          : `🛑 安全审计: 违规指令已拦截 (${duration}ms · 拦截执行)`;
      }

      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        let stepBadge = document.getElementById('step-badge-' + currentActiveAssistantId + '-firewall');
        if (!stepBadge) {
          stepBadge = document.createElement('div');
          stepBadge.id = 'step-badge-' + currentActiveAssistantId + '-firewall';
          stepsContainer.appendChild(stepBadge);
        }
        stepBadge.className = 'assistant-step-badge completed';
        stepBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        stepBadge.style.color = '#f59e0b';
        stepBadge.innerHTML = `<span style="color:#ef4444;">🛑</span> <span>${isEn ? 'Edge Firewall Policy Intercepted' : '安全合规网关介入拦截'}</span> <span class="step-time">${duration}ms</span>`;
      }

      if (respEl) {
        respEl.innerHTML = `
          <div class="security-guardrail-banner">
            <div class="guardrail-header">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>${isEn ? '⚠️ NanoMesh Safety & Compliance Guardrail' : '⚠️ NanoMesh 安全合规防护'}</span>
            </div>
            <div class="guardrail-body">
              <p style="margin: 0 0 10px 0;">
                ${isEn
                  ? 'Sorry, your instruction was audited by the Edge Firewall and flagged for unauthorized system attacks, weaponized exploits, or intellectual property infringements. Execution has been terminated without consuming compute credits. Please refer to <a href="/terms" target="_blank" class="guardrail-link">NanoMesh Terms of Service</a>.'
                  : '抱歉，您的指令经安全网关审计，涉及未授权系统攻击、入侵工具武器化或侵犯版权等违规行为。该请求已被终止执行，未扣除算力点数。请参阅 <a href="/terms" target="_blank" class="guardrail-link">NanoMesh 服务条款</a>。'
                }
              </p>
              <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                ${isEn
                  ? 'If this was intended for defensive security configurations or academic research, please adjust your phrasing. Continued violations may lead to account suspension.'
                  : '如为您自建环境的防御性安全配置或学术分析，请调整表述明确防御上下文。如果您持续进行违规活动，您的账号可能被暂停。'
                }
              </p>
            </div>
          </div>
        `;
      }

      const actionsEl = document.getElementById('actions-' + assistantId);
      if (actionsEl) actionsEl.style.display = 'none';

      smartScrollToBottom(document.getElementById('chat-messages'));
    } else if (event === 'capability_unreachable') {
      if (streamingRafMap.has(assistantId)) {
        cancelAnimationFrame(streamingRafMap.get(assistantId));
        streamingRafMap.delete(assistantId);
      }
      streamingTextBuffers.delete(assistantId);

      const isEn = getLocale() === 'en';
      const duration = data.duration_ms || 32;

      const currentArbPill = (currentActiveRunId && document.getElementById('arb-pill-' + currentActiveRunId)) || arbPill;
      const currentArbText = (currentActiveRunId && document.getElementById('arb-text-' + currentActiveRunId)) || arbText;
      if (currentArbPill) {
        currentArbPill.className = 'telemetry-pill arb-telemetry-pill locked';
        currentArbPill.style.borderColor = 'rgba(161, 161, 170, 0.4)';
        currentArbPill.style.color = '#a1a1aa';
      }
      if (currentArbText) {
        currentArbText.textContent = isEn
          ? `🛡️ Compute Guard: Fast-Failed (${duration}ms · 100% Saved)`
          : `🛡️ 算力防护: 触发快速熔断 (${duration}ms · 节省算力 100%)`;
      }

      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        let stepBadge = document.getElementById('step-badge-' + currentActiveAssistantId + '-unreachable');
        if (!stepBadge) {
          stepBadge = document.createElement('div');
          stepBadge.id = 'step-badge-' + currentActiveAssistantId + '-unreachable';
          stepsContainer.appendChild(stepBadge);
        }
        stepBadge.className = 'assistant-step-badge completed';
        stepBadge.style.borderColor = 'rgba(161, 161, 170, 0.3)';
        stepBadge.style.color = '#a1a1aa';
        stepBadge.innerHTML = `<span style="color:#71717a;">∅</span> <span>${isEn ? 'Catalog Capability Out of Bounds (Fast-Failed)' : '候选模板胜任度未达标 (Fast-Failed)'}</span> <span class="step-time">${duration}ms</span>`;
      }

      if (respEl) {
        respEl.innerHTML = `
          <div class="capability-guardrail-banner">
            <div class="guardrail-header">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#818cf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
              </svg>
              <span>${isEn ? '∅ Intent Unreachable / Capability Boundary' : '∅ 意图不可达 / 能力边界熔断'}</span>
            </div>
            <div class="guardrail-body">
              <p style="margin: 0 0 10px 0;">
                ${isEn
                  ? 'No workflow template in the current catalog matches your specific intent. NanoMesh is currently specialized in multimodal visual understanding, entity extraction, cross-lingual translation, and structured polishing. The system has fast-failed to protect your compute credits with 0 charges.'
                  : '当前工作流库未检索到能够胜任该业务意图的编排链路。NanoMesh 目前专精于多模态图文解析、实体信息抽取、跨语言重构与结构化表达润色。系统已在极短时间内快速熔断本轮执行，未消耗您的任何算力点数。'
                }
              </p>
              <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                ${isEn
                  ? '*(Tip: Try uploading multimodal materials or refining your text analysis goals)*'
                  : '*(建议：您可以尝试上传多模态图文材料，或细化您在文字润色、文档抽取方面的诉求)*'
                }
              </p>
            </div>
          </div>
        `;
      }

      const actionsEl = document.getElementById('actions-' + assistantId);
      if (actionsEl) actionsEl.style.display = 'none';

    } else if (event === 'dag_complete') {
      if (data.has_client_exec || window._activeLocalRunnerPromise) {
        // Handed off to browser local worker; keep workflow executing until local worker finishes!
        return;
      }
      setWorkflowExecutionLocked(false);
      const sink = document.getElementById('dag-sink-anchor');
      if (sink) {
        sink.classList.remove('is-executing');
        sink.classList.add('completed');
      }
      requestAnimationFrame(() => renderDagSvgConnectors());

      if (streamingRafMap.has(assistantId)) {
        cancelAnimationFrame(streamingRafMap.get(assistantId));
        streamingRafMap.delete(assistantId);
      }

      const isFastFailed = !!(data.is_security_violation || data.is_unreachable);
      window._isCurrentTurnRolledBack = isFastFailed;

      const rawFinal = isFastFailed
        ? ''
        : (data.final_output || streamingTextBuffers.get(assistantId) || (respEl ? respEl.textContent.trim() : ''));
      const finalAssistantOutput = sanitizePromptLeakage(rawFinal);
      streamingTextBuffers.delete(assistantId);

      if (isFastFailed) {
        // Atomic Rollback: Restore clean state before this failed turn was initiated
        if (window._currentPreFlightSnapshot) {
          window.sessionAssets = window._currentPreFlightSnapshot.sessionAssets;
          window.currentRoundAssets = window._currentPreFlightSnapshot.currentRoundAssets;
          window.lastRoundSummary = window._currentPreFlightSnapshot.lastRoundSummary;
          window.currentDagBaseSummary = window._currentPreFlightSnapshot.currentDagBaseSummary;
          window.activeBranchId = window._currentPreFlightSnapshot.activeBranchId;
          window.sessionBranches = window._currentPreFlightSnapshot.sessionBranches;
        }
        window._currentStagedNewFiles = [];
        window.lastHadMedia = (window.sessionAssets || []).some(a => {
          const m = a.modality || (a.type && a.type.startsWith('image/') ? 'image' : (a.type && a.type.startsWith('audio/') ? 'audio' : ''));
          return m === 'image' || m === 'audio';
        });
      } else {
        // Atomic Commit: Formalize staged assets and update branch lineage
        if (Array.isArray(window._currentStagedNewFiles) && window._currentStagedNewFiles.length > 0) {
          window._currentStagedNewFiles.forEach(f => {
            const existing = window.sessionAssets.find(sa => sa.assetId === f.assetId || (sa.name === f.name && sa.size === f.size));
            if (!existing) {
              window.sessionAssets.push({ ...f, isNew: false });
            } else {
              existing.isNew = false;
            }
          });
        }
        window._currentStagedNewFiles = [];

        // Branch Transition & Context Springback (记忆回弹算法)
        const intent = window.currentRoundIntentState;
        window.sessionBranches = window.sessionBranches || {};
        const promptSnippet = (window.lastUserPrompt || '').slice(0, 50);

        if (intent === 'REBIND_ROOT') {
          // Context Springback: Return to media branch
          const mediaBranchId = (window.sessionBranches[window.activeBranchId]?.isMediaBranch)
            ? window.activeBranchId
            : (Object.keys(window.sessionBranches).find(k => window.sessionBranches[k].isMediaBranch) || window.activeBranchId || 'main');
          window.activeBranchId = mediaBranchId;
          window.sessionBranches[mediaBranchId] = window.sessionBranches[mediaBranchId] || {
            branchId: mediaBranchId,
            topic: '多模态媒体探查与分析',
            isMediaBranch: true,
            lastValidSummary: ''
          };
          if (finalAssistantOutput) {
            window.sessionBranches[mediaBranchId].lastValidSummary = finalAssistantOutput.slice(0, 4000);
          }
        } else if (intent === 'DETACH_RESET') {
          // Fork new independent branch
          const hasMedia = (window.currentRoundAssets || []).some(a => a.modality === 'image' || a.modality === 'audio');
          const forkBranchId = (hasMedia ? 'branch_media_' : 'branch_chat_') + Date.now();
          window.sessionBranches[forkBranchId] = {
            branchId: forkBranchId,
            topic: promptSnippet || '独立新任务',
            isMediaBranch: hasMedia,
            lastValidSummary: finalAssistantOutput ? finalAssistantOutput.slice(0, 4000) : ''
          };
          window.activeBranchId = forkBranchId;
        } else if (intent === 'SWITCH_BRANCH') {
          // Springback onto the switched branch
          const curBranchId = window.activeBranchId || 'main';
          if (window.sessionBranches[curBranchId]) {
            if (finalAssistantOutput) {
              window.sessionBranches[curBranchId].lastValidSummary = finalAssistantOutput.slice(0, 4000);
            }
          }
        } else if (intent === 'CROSS_FUSION') {
          // Fuse onto media branch
          window.activeBranchId = 'branch_media';
          window.sessionBranches['branch_media'] = window.sessionBranches['branch_media'] || {
            branchId: 'branch_media',
            topic: '多模态跨轮对比融合',
            isMediaBranch: true,
            lastValidSummary: ''
          };
          if (finalAssistantOutput) {
            window.sessionBranches['branch_media'].lastValidSummary = finalAssistantOutput.slice(0, 4000);
          }
        } else {
          // ANCHOR_TAIL or standard: continue on active branch
          const curBranchId = window.activeBranchId || 'main';
          const hasMediaCurrent = (window.sessionAssets || []).some(a => {
            const m = a.modality || (a.type && a.type.startsWith('image/') ? 'image' : (a.type && a.type.startsWith('audio/') ? 'audio' : ''));
            return m === 'image' || m === 'audio';
          });
          window.sessionBranches[curBranchId] = window.sessionBranches[curBranchId] || {
            branchId: curBranchId,
            topic: promptSnippet || (hasMediaCurrent ? '多模态媒体分析' : '常规任务对话'),
            isMediaBranch: hasMediaCurrent,
            lastValidSummary: ''
          };
          if (promptSnippet && (!window.sessionBranches[curBranchId].topic || window.sessionBranches[curBranchId].topic === '多模态媒体分析' || window.sessionBranches[curBranchId].topic === '初始任务' || window.sessionBranches[curBranchId].topic === '常规任务对话')) {
            window.sessionBranches[curBranchId].topic = promptSnippet;
          }
          if (hasMediaCurrent && !window.sessionBranches[curBranchId].isMediaBranch) {
            window.sessionBranches[curBranchId].isMediaBranch = true;
          }
          if (finalAssistantOutput) {
            window.sessionBranches[curBranchId].lastValidSummary = finalAssistantOutput.slice(0, 4000);
          }
        }

        if (finalAssistantOutput) {
          window.lastRoundSummary = finalAssistantOutput.slice(0, 4000);
          window.currentDagBaseSummary = window.lastRoundSummary;
        }
        window.lastHadMedia = (window.sessionAssets || []).some(a => {
          const m = a.modality || (a.type && a.type.startsWith('image/') ? 'image' : (a.type && a.type.startsWith('audio/') ? 'audio' : ''));
          return m === 'image' || m === 'audio';
        });
      }

      // Render clean Markdown if marked is available (skip if fast-failed to protect banner)
      if (!isFastFailed && respEl && finalAssistantOutput) {
        respEl.innerHTML = safeRenderMarkdown(finalAssistantOutput);

        const actionsEl = document.getElementById('actions-' + assistantId);
        if (actionsEl) actionsEl.classList.add('is-visible');
      }

      const scrollContainer = document.getElementById('chat-messages');
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;

      // Save complete dialogue history and trace snapshot to History Drawer
      const totalNodes = activeDagNodes.length || 1;
      const anyCached = activeDagNodes.some(n => n.cache_hit);
      const costStr = isFastFailed ? '0' : (data.total_cost !== undefined ? String(data.total_cost) : (anyCached ? '35' : '120'));
      const durStr = data.total_duration_ms ? (data.total_duration_ms / 1000).toFixed(1) + 's' : '2.8s';
      const promptText = window.lastUserPrompt || userPrompt || '';

      const stepsList = [];
      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        stepsContainer.querySelectorAll('.assistant-step-badge').forEach(b => {
          stepsList.push({
            html: b.innerHTML,
            className: b.className
          });
        });
      }

      const currentRoundData = {
        runId: currentActiveRunId || ('run-' + Date.now()),
        roundIndex: window.chatRoundIndex || 1,
        userPrompt: promptText,
        assets: window.currentRoundAssets || [],
        assistantOutput: finalAssistantOutput,
        template: window.currentRunningTemplateObj || (currentCandidateTemplates.find(t => t.template_id === window.currentRunningTemplateId)) || null,
        candidateTemplates: currentCandidateTemplates || [],
        nodes: JSON.parse(JSON.stringify(activeDagNodes || [])),
        steps: stepsList,
        intentState: window.currentRoundIntentState || null,
        branchId: window.activeBranchId,
        isFastFailed: isFastFailed,
        cost: costStr,
        duration: durStr,
        cached: anyCached,
        timestamp: Date.now()
      };

      saveTraceToHistory({
        sessionId: window.chatSessionId,
        title: promptText.slice(0, 30) || '多模态任务编排',
        cost: costStr,
        duration: durStr,
        nodesCount: totalNodes,
        cached: anyCached,
        round: currentRoundData
      });
    } else if (event === 'dag_error') {
      setWorkflowExecutionLocked(false);
      requestAnimationFrame(() => renderDagSvgConnectors());
      if (streamingRafMap.has(assistantId)) {
        cancelAnimationFrame(streamingRafMap.get(assistantId));
        streamingRafMap.delete(assistantId);
      }
      streamingTextBuffers.delete(assistantId);

      const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
      const errText = data.error || (isEn ? 'Workflow execution interrupted' : '工作流执行异常中断');
      if (respEl) {
        respEl.innerHTML = `<div class="dag-execution-error-banner" style="color:#ef4444; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); padding:10px 14px; border-radius:8px; margin-top:8px; font-size:0.88rem;">
          <div style="font-weight:600; margin-bottom:4px;">⚠️ ${isEn ? 'Task Interrupted' : '任务执行中断'}</div>
          <div>${escapeHtml(errText)}</div>
        </div>`;
      }
      // Remove running spinner from any active node card and mark as error
      document.querySelectorAll('.dag-node-card.running').forEach(card => {
        card.classList.remove('running');
        card.classList.add('error');
        const roleId = card.getAttribute('data-role-id');
        const meta = document.getElementById('node-meta-' + roleId);
        if (meta) meta.textContent = isEn ? 'Aborted' : '异常中断';
      });
      // Update step badge to error
      const stepsContainer = document.getElementById('assistant-steps-' + currentActiveAssistantId);
      if (stepsContainer) {
        const runningBadge = stepsContainer.querySelector('.assistant-step-badge.running');
        if (runningBadge) {
          runningBadge.className = 'assistant-step-badge error';
          runningBadge.innerHTML = `<span style="color:#ef4444">⚠️</span> <span style="color:#ef4444">${isEn ? 'Aborted' : '执行中断'}</span>`;
        }
      }
    }
  }

  // Close dropdowns & popovers on outside click
  document.addEventListener('click', (e) => {
    const macroDropdown = document.getElementById('macro-dropdown');
    if (macroDropdown && !e.target.closest('#macro-capsule-btn') && !e.target.closest('#macro-dropdown')) {
      macroDropdown.style.display = 'none';
    }
    const inspector = document.getElementById('node-inspector-popover');
    if (inspector && !e.target.closest('#node-inspector-popover') && !e.target.closest('.dag-node-card')) {
      if (inspector.style.display !== 'none') {
        if (currentInspectedNodeRoleId) {
          const selectEl = document.getElementById('inspector-model-select');
          const promptEl = document.getElementById('inspector-prompt-input');
          if (selectEl && promptEl) {
            window.activeCustomRolePrompts = window.activeCustomRolePrompts || {};
            window.activeCustomRolePrompts[currentInspectedNodeRoleId] = promptEl.value.trim();
            window.activeChosenRoleModels = window.activeChosenRoleModels || {};
            window.activeChosenRoleModels[currentInspectedNodeRoleId] = selectEl.value;
            updateNodeDirtyState(currentInspectedNodeRoleId);
          }
          currentInspectedNodeRoleId = null;
        }
        inspector.style.display = 'none';
      }
    }
  });

  // Typewriter effect for card prompt injection
  let typewriterTimer = null;

  function typewriteIntoInput(text) {
    const input = document.getElementById('chat-input');
    if (!input || !text) return;

    if (typewriterTimer) {
      clearInterval(typewriterTimer);
      typewriterTimer = null;
    }

    input.value = '';
    input.focus();
    let idx = 0;
    // Smooth, snappy typing speed (~12ms per char)
    const speed = 12;

    typewriterTimer = setInterval(() => {
      if (idx < text.length) {
        input.value += text[idx];
        idx++;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
        if (typeof updateEstimation === 'function') updateEstimation();
      } else {
        clearInterval(typewriterTimer);
        typewriterTimer = null;
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    }, speed);
  }

  // Clear typewriter if user starts manual typing
  document.getElementById('chat-input')?.addEventListener('input', () => {
    if (typewriterTimer) {
      clearInterval(typewriterTimer);
      typewriterTimer = null;
    }
  });

  // Stage 1: Bind Suggested Prompt Cards Click Handler (Typewriter fill only, submit enters console)
  document.querySelectorAll('.suggested-prompts-grid .prompt-card').forEach(card => {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const promptKey = card.getAttribute('data-i18n-prompt');
      let prompt = '';
      if (promptKey && typeof t === 'function') {
        const translated = t(promptKey);
        if (translated && translated !== promptKey) {
          prompt = translated;
        }
      }
      if (!prompt) {
        prompt = card.getAttribute('data-prompt') || '';
      }
      if (prompt) {
        typewriteIntoInput(prompt);
      }
    });
  });

  // Responsive Mobile Tab Switcher (< 1024px)
  const tabBtnCanvas = document.getElementById('tab-btn-canvas');
  const tabBtnStream = document.getElementById('tab-btn-stream');
  const canvasPane = document.getElementById('workbench-canvas-pane');
  const streamPane = document.getElementById('stream-terminal-pane');

  if (tabBtnCanvas && tabBtnStream) {
    tabBtnCanvas.onclick = () => {
      tabBtnCanvas.classList.add('active');
      tabBtnStream.classList.remove('active');
      canvasPane?.classList.add('tab-active');
      streamPane?.classList.remove('tab-active');
      requestAnimationFrame(() => renderDagSvgConnectors());
      setTimeout(() => renderDagSvgConnectors(), 50);
      setTimeout(() => renderDagSvgConnectors(), 200);
    };
    tabBtnStream.onclick = () => {
      tabBtnStream.classList.add('active');
      tabBtnCanvas.classList.remove('active');
      streamPane?.classList.add('tab-active');
      canvasPane?.classList.remove('tab-active');
    };
  }

  // Initialize Stage 5 History Drawer & Console Back Button & Macro Reroute Button & Observers
  initHistoryDrawer();
  initConsoleBackButton();
  initMacroRerouteButton();
  initDagResizeObserver();
  initContextConstraintsPopover();
  initLocalInferenceToggle();
  initMessageCopyHandler();

  // Stage 4: Context Constraints Settings Popover Logic (Language & Style)
  function initContextConstraintsPopover() {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsMenu = document.getElementById('settings-menu');
    const popoverWrapper = document.getElementById('settings-popover-wrapper');
    const langTrigger = document.getElementById('lang-trigger');
    const langOptions = document.getElementById('lang-options');
    const langDisplay = document.getElementById('lang-display');
    const styleTrigger = document.getElementById('style-trigger');
    const styleOptions = document.getElementById('style-options');
    const styleDisplay = document.getElementById('style-display');

    if (!settingsBtn || !settingsMenu) return;

    // Load initial preferences
    const savedLang = localStorage.getItem('nanomesh_lang') || 'auto';
    const savedStyle = localStorage.getItem('nanomesh_style') || 'concise';

    function updateLangDisplay(val) {
      if (!langDisplay) return;
      const opt = langOptions?.querySelector(`.select-option[data-value="${val}"]`);
      if (opt) {
        langDisplay.textContent = opt.textContent;
        const i18nKey = opt.getAttribute('data-i18n');
        if (i18nKey) langDisplay.setAttribute('data-i18n', i18nKey);
      }
    }

    function updateStyleDisplay(val) {
      if (!styleDisplay) return;
      const opt = styleOptions?.querySelector(`.select-option[data-value="${val}"]`);
      if (opt) {
        styleDisplay.textContent = opt.textContent;
        const i18nKey = opt.getAttribute('data-i18n');
        if (i18nKey) styleDisplay.setAttribute('data-i18n', i18nKey);
      }
    }

    updateLangDisplay(savedLang);
    updateStyleDisplay(savedStyle);

    // Toggle popover visibility
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = settingsMenu.style.display !== 'none';
      if (isVisible) {
        settingsMenu.style.display = 'none';
        settingsBtn.classList.remove('active');
      } else {
        settingsMenu.style.display = 'flex';
        settingsBtn.classList.add('active');
      }
      if (langOptions) langOptions.style.display = 'none';
      if (styleOptions) styleOptions.style.display = 'none';
    });

    // Language dropdown toggle
    if (langTrigger && langOptions) {
      langTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = langOptions.style.display === 'block';
        langOptions.style.display = isOpen ? 'none' : 'block';
        if (styleOptions) styleOptions.style.display = 'none';
      });

      langOptions.querySelectorAll('.select-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.getAttribute('data-value') || 'auto';
          localStorage.setItem('nanomesh_lang', val);
          updateLangDisplay(val);
          langOptions.style.display = 'none';
        });
      });
    }

    // Style dropdown toggle
    if (styleTrigger && styleOptions) {
      styleTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = styleOptions.style.display === 'block';
        styleOptions.style.display = isOpen ? 'none' : 'block';
        if (langOptions) langOptions.style.display = 'none';
      });

      styleOptions.querySelectorAll('.select-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.getAttribute('data-value') || 'auto';
          localStorage.setItem('nanomesh_style', val);
          updateStyleDisplay(val);
          styleOptions.style.display = 'none';
        });
      });
    }

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (popoverWrapper && !popoverWrapper.contains(e.target)) {
        settingsMenu.style.display = 'none';
        settingsBtn.classList.remove('active');
        if (langOptions) langOptions.style.display = 'none';
        if (styleOptions) styleOptions.style.display = 'none';
      } else {
        // Clicked inside wrapper but outside specific select
        if (langOptions && !document.getElementById('lang-custom-select')?.contains(e.target)) {
          langOptions.style.display = 'none';
        }
        if (styleOptions && !document.getElementById('style-custom-select')?.contains(e.target)) {
          styleOptions.style.display = 'none';
        }
      }
    });
  }

  // Stage 4.5: Local Model Inference Toggle Button Logic (Disable Local Inference)
  window.disableLocalInference = localStorage.getItem('nanomesh_disable_local_inference') === 'true';

  function updateLocalInferenceToggleUI() {
    window.updateLocalInferenceToggleUI = updateLocalInferenceToggleUI;
    const btn = document.getElementById('local-inference-toggle-btn');
    if (!btn) return;
    const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
    const enabledSvg = btn.querySelector('.icon-local-enabled');
    const disabledSvg = btn.querySelector('.icon-local-disabled');

    if (window.disableLocalInference) {
      btn.classList.add('is-disabled-local', 'active');
      btn.setAttribute('title', isEn 
        ? (typeof t === 'function' ? t('chat.local_inference.disabled_tip') : 'Local inference disabled (Cloud only, click to enable)')
        : (typeof t === 'function' ? t('chat.local_inference.disabled_tip') : '已开启：不使用本地模型推理（强制仅使用云端模型，点击恢复）'));
      if (enabledSvg) enabledSvg.style.display = 'none';
      if (disabledSvg) disabledSvg.style.display = 'block';
    } else {
      btn.classList.remove('is-disabled-local', 'active');
      btn.setAttribute('title', isEn 
        ? (typeof t === 'function' ? t('chat.local_inference.enabled_tip') : 'Local inference enabled (Click to disable)')
        : (typeof t === 'function' ? t('chat.local_inference.enabled_tip') : '端侧本地推理已启用（点击开启：不使用本地模型推理）'));
      if (enabledSvg) enabledSvg.style.display = 'block';
      if (disabledSvg) disabledSvg.style.display = 'none';
    }
  }

  function initLocalInferenceToggle() {
    const btn = document.getElementById('local-inference-toggle-btn');
    if (!btn) return;
    updateLocalInferenceToggleUI();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.disableLocalInference = !window.disableLocalInference;
      localStorage.setItem('nanomesh_disable_local_inference', window.disableLocalInference ? 'true' : 'false');
      updateLocalInferenceToggleUI();

      const isEn = (typeof getLocale === 'function' ? getLocale() : 'zh') === 'en';
      const msg = window.disableLocalInference
        ? (typeof t === 'function' ? t('chat.local_inference.toast_disabled') : (isEn ? 'Local inference disabled (Cloud only)' : '已开启：不使用本地模型推理（仅云端调度）'))
        : (typeof t === 'function' ? t('chat.local_inference.toast_enabled') : (isEn ? 'Local inference enabled' : '已恢复：允许本地模型推理'));
      localToast(msg, 'info');
    });
  }

  // Stage 6: Chat Message Bubble Copy Handler (User & Assistant)
  function initMessageCopyHandler() {
    const messagesFlow = document.getElementById('messages-flow');
    if (!messagesFlow) return;

    messagesFlow.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.copy-btn, .chat-bubble-copy-btn, .chat-action-btn');
      if (!copyBtn) return;
      e.stopPropagation();

      let targetText = '';
      const userBubble = copyBtn.closest('.chat-bubble-user');
      if (userBubble) {
        const textEl = userBubble.querySelector('.chat-user-text');
        targetText = textEl ? textEl.innerText.trim() : '';
      } else {
        const responseWrapper = copyBtn.closest('.chat-response-wrapper') || copyBtn.closest('.chat-bubble-assistant');
        if (responseWrapper) {
          const textEl = responseWrapper.querySelector('.chat-response-text');
          targetText = textEl ? textEl.innerText.trim() : '';
        }
      }

      if (!targetText || targetText.startsWith('⚡ NanoMesh 调度执行中') || targetText.startsWith('⚡ NanoMesh Orchestrating')) return;

      const isEn = getLocale() === 'en';
      const onCopied = () => {
        const copyIcon = copyBtn.querySelector('.copy-icon');
        const checkIcon = copyBtn.querySelector('.check-icon');
        const btnText = copyBtn.querySelector('.btn-text');
        if (copyIcon && checkIcon) {
          copyIcon.style.display = 'none';
          checkIcon.style.display = 'block';
          if (btnText) btnText.textContent = isEn ? 'Copied' : '已复制';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyIcon.style.display = 'block';
            checkIcon.style.display = 'none';
            if (btnText) btnText.textContent = isEn ? 'Copy' : '复制';
            copyBtn.classList.remove('copied');
          }, 1500);
        }
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(targetText).then(onCopied).catch(() => {
          fallbackCopyText(targetText, onCopied);
        });
      } else {
        fallbackCopyText(targetText, onCopied);
      }
    });
  }

  function fallbackCopyText(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      if (cb) cb();
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(ta);
  }

  // Bind Send button & Enter key (with Button Morphing operational closure)
  document.getElementById('send-btn').addEventListener('click', () => {
    if (isWorkflowExecuting) return;
    if (window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.size > 0) {
      applyPendingCanvasChanges();
      return;
    }
    sendChatMessage();
  });
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isWorkflowExecuting) return;
      if (window.pendingModifiedRoleIds && window.pendingModifiedRoleIds.size > 0) {
        applyPendingCanvasChanges();
        return;
      }
      sendChatMessage();
    }
  });


  // Credits Dropdown
  const creditsMenuBtn = document.getElementById('credits-menu-btn');
  const creditsMenu = document.getElementById('credits-menu');
  if (creditsMenuBtn && creditsMenu) {
    creditsMenuBtn.addEventListener('click', (e) => {
      // Prevent triggering if clicked inside menu
      if (!creditsMenu.contains(e.target)) {
        creditsMenu.style.display = creditsMenu.style.display === 'none' ? 'block' : 'none';
      }
    });
    document.addEventListener('click', (e) => {
      if (!creditsMenuBtn.contains(e.target)) creditsMenu.style.display = 'none';
    });
  }

  // Upload Popover
  const attachBtn = document.getElementById('attach-btn');
  const attachMenu = document.getElementById('attach-menu');
  if (attachBtn && attachMenu) {
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachBtn.classList.toggle('active');
      attachMenu.style.display = attachMenu.style.display === 'none' ? 'flex' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) {
        attachBtn.classList.remove('active');
        attachMenu.style.display = 'none';
      }
    });
  }

  // Auto-resize textarea & Cost Estimation
  const chatInput = document.getElementById('chat-input');
  function updateEstimation() {
    if (!chatInput) return;
    const textLen = chatInput.value.length;
    const filesCount = selectedFiles ? selectedFiles.length : 0;
    const est = Math.max(0, Math.ceil(textLen / 50)) + (filesCount * 15);
    const estEl = document.getElementById('est-cost');
    if (estEl && typeof t === 'function') {
      estEl.textContent = t('chat.estCost', { n: est });
    }
  }

  if (chatInput) {
    chatInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
      updateEstimation();
    });
  }

  // --- Settings Modal Logic ---
  const personalSettingsBtn = document.getElementById('settings-menu-btn');
  const settingsModalOverlay = document.getElementById('settings-modal-overlay');
  const settingsCloseBtn = document.getElementById('settings-close-btn');

  window.openSettingsModal = function(tabName = 'account') {
    const overlay = document.getElementById('settings-modal-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const userMenu = document.getElementById('user-menu');
    if (userMenu) userMenu.style.display = 'none';
    const targetNav = document.querySelector(`.settings-nav-item[data-tab="${tabName}"]`);
    if (targetNav) targetNav.click();
    if (window.refreshOAuthBindings) {
      window.refreshOAuthBindings();
    }
    if (window.refreshPasskeys) {
      window.refreshPasskeys();
    }
  };

  if (personalSettingsBtn && settingsModalOverlay && settingsCloseBtn) {
    personalSettingsBtn.addEventListener('click', () => {
      window.openSettingsModal('account');
    });

    settingsCloseBtn.addEventListener('click', () => {
      settingsModalOverlay.style.display = 'none';
    });

    // Close on overlay click
    settingsModalOverlay.addEventListener('click', (e) => {
      if (e.target === settingsModalOverlay) {
        settingsModalOverlay.style.display = 'none';
      }
    });

    // Tab Switching
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        // Remove active class from all nav items
        document.querySelectorAll('.settings-nav-item').forEach(nav => nav.classList.remove('active'));
        // Add active class to clicked item
        item.classList.add('active');

        // Hide all panes
        document.querySelectorAll('.settings-tab-pane').forEach(pane => pane.classList.remove('active'));
        
        // Show target pane
        const tabId = item.getAttribute('data-tab');
        document.getElementById('settings-tab-' + tabId).classList.add('active');
        if (tabId === 'account') { 
          if (window.refreshOAuthBindings) window.refreshOAuthBindings(); 
          if (window.refreshPasskeys) window.refreshPasskeys();
        }
        if (tabId === 'billing') { if (window.loadBillingLedger) window.loadBillingLedger(window.currentBillingFilter || 'all'); }
        if (tabId === 'models') { if (window.loadMyModels) window.loadMyModels(); }
        if (tabId === 'messages') { if (window.loadMessagesTab) window.loadMessagesTab('all'); }
      });
    });

    // Sub-tab switching for Billing
    document.querySelectorAll('.settings-tab-sub').forEach(subItem => {
      subItem.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab-sub').forEach(el => el.classList.remove('active'));
        subItem.classList.add('active');
      });
    });

    // Profile UI Interactions
    const usernameInput = document.getElementById('settings-username-input');
    const saveUsernameBtn = document.getElementById('save-username-btn');
    if (usernameInput && saveUsernameBtn && user) {
      usernameInput.addEventListener('input', () => {
        if (usernameInput.value.trim() !== user.username && usernameInput.value.trim() !== '') {
          saveUsernameBtn.disabled = false;
          saveUsernameBtn.classList.add('btn-primary');
          saveUsernameBtn.classList.remove('btn-outline');
        } else {
          saveUsernameBtn.disabled = true;
          saveUsernameBtn.classList.remove('btn-primary');
          saveUsernameBtn.classList.add('btn-outline');
        }
      });
    }
    
    // Avatar Upload Logic
    const avatarInput = document.getElementById('avatar-upload-input');
    const avatarBtn = document.getElementById('avatar-upload-btn');
    if (avatarInput && user) {
      avatarInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        avatarBtn.style.opacity = '0.5';
        avatarBtn.style.pointerEvents = 'none';
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
          const res = await fetch('/api/user/avatar', {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          if (!res.ok) {
            localToast(t(data.error || 'error.uploadFailed'));
          } else {
            localToast(t('success.avatarUpdated'), 'success');
            // Update preview
            document.getElementById('settings-avatar-preview').src = data.avatar_url;
            const dropdownImg = document.getElementById('dropdown-avatar-img');
            if(dropdownImg) {
              dropdownImg.src = data.avatar_url;
              dropdownImg.style.display = 'block';
              document.getElementById('dropdown-avatar-text').style.display = 'none';
            }
            const headerAvatar = document.getElementById('user-avatar');
            if (headerAvatar) {
              headerAvatar.innerHTML = `<img src="${data.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
            }
            avatarInput.value = ''; // Reset
            
            // Also disable it until next reload (or simulate 24h)
            avatarBtn.style.opacity = '0.5';
            avatarBtn.style.pointerEvents = 'none';
            avatarBtn.title = t('error.avatarCooldown');
            return; // Skip the 'finally' block re-enabling it
          }
        } catch (err) {
          localToast(t('error.networkError'));
        }
        
        avatarBtn.style.opacity = '1';
        avatarBtn.style.pointerEvents = 'auto';
      });
    }

    // Security Accordion
    const togglePasswordBtn = document.getElementById('toggle-password-btn');
    const passwordAccordion = document.getElementById('password-accordion');
    const cancelPasswordBtn = document.getElementById('cancel-password-btn');
    
    if (togglePasswordBtn && passwordAccordion && cancelPasswordBtn) {
      togglePasswordBtn.addEventListener('click', () => {
        passwordAccordion.classList.add('active');
        togglePasswordBtn.style.display = 'none';
      });
      cancelPasswordBtn.addEventListener('click', () => {
        passwordAccordion.classList.remove('active');
        togglePasswordBtn.style.display = 'block';
        // Clear inputs
        document.getElementById('settings-old-password').value = '';
        const np = document.getElementById('settings-new-password');
        const cp = document.getElementById('settings-confirm-password');
        if (np) { np.value = ''; np.type = 'password'; }
        if (cp) { cp.value = ''; cp.type = 'password'; }
        const tnp = document.getElementById('toggle-new-pwd-btn');
        const tcp = document.getElementById('toggle-confirm-pwd-btn');
        const eyeOpenSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        if (tnp) tnp.innerHTML = eyeOpenSvg;
        if (tcp) tcp.innerHTML = eyeOpenSvg;
      });

      const generatePwdBtn = document.getElementById('generate-pwd-btn');
      const toggleNewPwdBtn = document.getElementById('toggle-new-pwd-btn');
      const toggleConfirmPwdBtn = document.getElementById('toggle-confirm-pwd-btn');
      const newPwdInput = document.getElementById('settings-new-password');
      const confirmPwdInput = document.getElementById('settings-confirm-password');
      const eyeOpenSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
      const eyeClosedSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"></path></svg>';

      if (generatePwdBtn) {
        generatePwdBtn.addEventListener('click', () => {
          let randStr = '';
          const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
          const numbers = '0123456789';
          const all = letters + numbers;
          randStr += letters[Math.floor(Math.random() * letters.length)];
          randStr += numbers[Math.floor(Math.random() * numbers.length)];
          for(let i=0; i<10; i++) randStr += all[Math.floor(Math.random() * all.length)];
          randStr = randStr.split('').sort(() => 0.5 - Math.random()).join('');
          if (newPwdInput) {
            newPwdInput.value = randStr;
            newPwdInput.type = 'text'; // Show it to user!
            if (toggleNewPwdBtn) toggleNewPwdBtn.innerHTML = eyeClosedSvg;
            newPwdInput.dispatchEvent(new Event('input'));
          }
          if (confirmPwdInput) {
            confirmPwdInput.value = randStr;
            confirmPwdInput.type = 'text';
            if (toggleConfirmPwdBtn) toggleConfirmPwdBtn.innerHTML = eyeClosedSvg;
            confirmPwdInput.dispatchEvent(new Event('input'));
          }
        });
      }

      if (toggleNewPwdBtn) {
        toggleNewPwdBtn.addEventListener('click', () => {
          if (newPwdInput.type === 'password') {
            newPwdInput.type = 'text';
            toggleNewPwdBtn.innerHTML = eyeClosedSvg;
          } else {
            newPwdInput.type = 'password';
            toggleNewPwdBtn.innerHTML = eyeOpenSvg;
          }
        });
      }

      if (toggleConfirmPwdBtn) {
        toggleConfirmPwdBtn.addEventListener('click', () => {
          if (confirmPwdInput.type === 'password') {
            confirmPwdInput.type = 'text';
            toggleConfirmPwdBtn.innerHTML = eyeClosedSvg;
          } else {
            confirmPwdInput.type = 'password';
            toggleConfirmPwdBtn.innerHTML = eyeOpenSvg;
          }
        });
      }

      document.getElementById('save-password-btn')?.addEventListener('click', async () => {
        const oldPassword = document.getElementById('settings-old-password').value;
        const newPassword = document.getElementById('settings-new-password').value;
        const confirmPassword = document.getElementById('settings-confirm-password').value;
        if (!newPassword) return;
        if (newPassword !== confirmPassword) {
          localToast(t('auth.passwordMismatch'));
          return;
        }
        const res = await fetch('/api/user/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) {
          localToast(t(data.error));
        } else {
          localToast(t('success.passwordUpdated'), 'success');
          cancelPasswordBtn.click();
        }
      });
    }

    if (saveUsernameBtn) {
      saveUsernameBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        if (!username) return;
        saveUsernameBtn.disabled = true;
        const res = await fetch('/api/user/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (!res.ok) {
          localToast(t(data.error));
          saveUsernameBtn.disabled = false;
        } else {
          user.username = username;
          document.getElementById('settings-username-display').textContent = username;
          document.getElementById('user-menu-name').textContent = username;
          document.getElementById('sidebar-user-name').textContent = username;
          localToast(t('success.usernameUpdated'), 'success');
          saveUsernameBtn.classList.remove('btn-primary');
          saveUsernameBtn.classList.add('btn-outline');
        }
      });
    }

    // Passkey Add Button
    document.getElementById('btn-add-passkey')?.addEventListener('click', () => {
      if (typeof window.handleAddPasskey === 'function') {
        window.handleAddPasskey();
      }
    });

    // --- Compliance Modal Logic ---
    const btnUploadModel = document.getElementById('btn-upload-model');
    const complianceOverlay = document.getElementById('compliance-modal-overlay');
    const complianceCheckbox = document.getElementById('compliance-checkbox');
    const complianceAgreeBtn = document.getElementById('compliance-agree-btn');
    const complianceCancelBtn = document.getElementById('compliance-cancel-btn');

    if (btnUploadModel && complianceOverlay && complianceCheckbox && complianceAgreeBtn && complianceCancelBtn) {
      // 1. Open Modal
      btnUploadModel.addEventListener('click', () => {
        complianceOverlay.classList.add('active');
        // Reset state
        complianceCheckbox.checked = false;
        complianceAgreeBtn.disabled = true;
        complianceAgreeBtn.style.opacity = '0.5';
        complianceAgreeBtn.style.cursor = 'not-allowed';
      });

      // 2. Checkbox Logic
      complianceCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          complianceAgreeBtn.disabled = false;
          complianceAgreeBtn.style.opacity = '1';
          complianceAgreeBtn.style.cursor = 'pointer';
        } else {
          complianceAgreeBtn.disabled = true;
          complianceAgreeBtn.style.opacity = '0.5';
          complianceAgreeBtn.style.cursor = 'not-allowed';
        }
      });

      // 3. Cancel Logic
      complianceCancelBtn.addEventListener('click', () => {
        complianceOverlay.classList.remove('active');
      });
      
      // Click outside to cancel
      complianceOverlay.addEventListener('click', (e) => {
        if (e.target === complianceOverlay) {
          complianceOverlay.classList.remove('active');
        }
      });

      // 4. Agree Logic → Open Upload Form
      complianceAgreeBtn.addEventListener('click', () => {
        complianceOverlay.classList.remove('active');
        openUploadForm();
      });
    }

    // --- Upload Form Modal Logic ---
    const uploadOverlay = document.getElementById('upload-form-overlay');
    const uploadCancelBtn = document.getElementById('upload-form-cancel');
    const uploadSubmitBtn = document.getElementById('upload-form-submit');
    const uploadDropzone = document.getElementById('upload-dropzone');
    const uploadFileInput = document.getElementById('upload-file-input');
    const uploadFileInfo = document.getElementById('upload-file-info');
    const uploadFileName = document.getElementById('upload-file-name');
    const uploadFileRemove = document.getElementById('upload-file-remove');
    const uploadDescription = document.getElementById('upload-description');
    const uploadCharCount = document.getElementById('upload-char-count');

    let selectedFile = null;

    function openUploadForm() {
      if (!uploadOverlay) return;
      // Reset form
      selectedFile = null;
      if (uploadFileInput) uploadFileInput.value = '';
      if (uploadFileInfo) uploadFileInfo.style.display = 'none';
      if (uploadDropzone) uploadDropzone.style.display = '';
      const nameInput = document.getElementById('upload-display-name');
      if (nameInput) {
        nameInput.value = '';
        nameInput.classList.remove('input-invalid', 'error-flash');
      }
      if (uploadDescription) {
        uploadDescription.classList.remove('input-invalid', 'error-flash');
      }
      const paramGrp = document.getElementById('upload-param-scale');
      if (paramGrp) paramGrp.classList.remove('error-flash');
      const dropz = document.getElementById('upload-dropzone');
      if (dropz) dropz.classList.remove('error-flash');
      const inModsGrp = document.getElementById('upload-in-modalities');
      if (inModsGrp) inModsGrp.classList.remove('error-flash');
      const outModsGrp = document.getElementById('upload-out-modality');
      if (outModsGrp) outModsGrp.classList.remove('error-flash');
      document.querySelectorAll('#upload-param-scale .upload-seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === 0);
      });
      // Reset checkboxes
      document.querySelectorAll('#upload-in-modalities input[type="checkbox"]').forEach((cb, i) => {
        cb.checked = (i === 0); // default text checked
      });
      document.querySelectorAll('#upload-out-modality input[type="radio"]').forEach((rb, i) => {
        rb.checked = (i === 0); // default text
      });
      document.querySelectorAll('#upload-capability-tags input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.disabled = false;
      });
      // Reset segmented
      document.querySelectorAll('#upload-context-window .upload-seg-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === 0);
      });
      if (uploadDescription) uploadDescription.value = '';
      if (uploadCharCount) uploadCharCount.textContent = '0 / 200';

      uploadOverlay.classList.add('active');
    }

    if (uploadOverlay) {
      // Click outside to close
      uploadOverlay.addEventListener('click', (e) => {
        if (e.target === uploadOverlay) {
          uploadOverlay.classList.remove('active');
        }
      });
    }

    if (uploadCancelBtn) {
      uploadCancelBtn.addEventListener('click', () => {
        uploadOverlay.classList.remove('active');
      });
    }

    // Dropzone interactions
    if (uploadDropzone && uploadFileInput) {
      uploadDropzone.addEventListener('click', () => uploadFileInput.click());
      uploadDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadDropzone.classList.add('dragover');
      });
      uploadDropzone.addEventListener('dragleave', () => {
        uploadDropzone.classList.remove('dragover');
      });
      uploadDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadDropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
          handleFileSelect(e.dataTransfer.files[0]);
        }
      });
      uploadFileInput.addEventListener('change', () => {
        if (uploadFileInput.files.length > 0) {
          handleFileSelect(uploadFileInput.files[0]);
        }
      });
    }

    function handleFileSelect(file) {
      if (file.size > 3 * 1024 * 1024 * 1024) {
        localToast(t('errorTooLarge3GB') || 'File too large', 'error');
        return;
      }
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext !== 'gguf' && ext !== 'safetensors') {
        localToast(t('error.unsupportedFile') || 'Unsupported file type', 'error');
        return;
      }
      selectedFile = file;
      const sizeStr = file.size > 1e9
        ? (file.size / 1e9).toFixed(2) + ' GB'
        : (file.size / 1e6).toFixed(1) + ' MB';
      if (uploadFileName) uploadFileName.textContent = `${file.name} (${sizeStr})`;
      if (uploadFileInfo) uploadFileInfo.style.display = 'flex';
      if (uploadDropzone) uploadDropzone.style.display = 'none';
    }

    if (uploadFileRemove) {
      uploadFileRemove.addEventListener('click', () => {
        selectedFile = null;
        if (uploadFileInput) uploadFileInput.value = '';
        if (uploadFileInfo) uploadFileInfo.style.display = 'none';
        if (uploadDropzone) uploadDropzone.style.display = '';
      });
    }

    // Capability tags: max 3
    const capTagGroup = document.getElementById('upload-capability-tags');
    if (capTagGroup) {
      capTagGroup.addEventListener('change', () => {
        const checked = capTagGroup.querySelectorAll('input:checked');
        const unchecked = capTagGroup.querySelectorAll('input:not(:checked)');
        if (checked.length >= 3) {
          unchecked.forEach(cb => cb.disabled = true);
        } else {
          capTagGroup.querySelectorAll('input').forEach(cb => cb.disabled = false);
        }
      });
    }

    // Segmented control (Param Scale)
    const paramGroup = document.getElementById('upload-param-scale');
    if (paramGroup) {
      paramGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.upload-seg-btn');
        if (!btn) return;
        paramGroup.querySelectorAll('.upload-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    }

    // Segmented control (Context Window)
    const segGroup = document.getElementById('upload-context-window');
    if (segGroup) {
      segGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.upload-seg-btn');
        if (!btn) return;
        segGroup.querySelectorAll('.upload-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    }

    // Description char counter
    if (uploadDescription && uploadCharCount) {
      uploadDescription.addEventListener('input', () => {
        uploadCharCount.textContent = `${uploadDescription.value.length} / 200`;
      });
    }

    // Submit handler
    if (uploadSubmitBtn) {
      uploadSubmitBtn.addEventListener('click', () => {
        // Validation
        const displayName = document.getElementById('upload-display-name')?.value?.trim() || '';
        const paramBtn = document.querySelector('#upload-param-scale .upload-seg-btn.active');
        const paramScale = paramBtn ? paramBtn.dataset.value : '';
        const inMods = Array.from(document.querySelectorAll('#upload-in-modalities input:checked')).map(cb => cb.value);
        const outMod = document.querySelector('#upload-out-modality input:checked')?.value || '';
        const ctxBtn = document.querySelector('#upload-context-window .upload-seg-btn.active');
        const contextWindow = ctxBtn ? parseInt(ctxBtn.dataset.value) : 4096;
        const description = uploadDescription?.value?.trim() || '';
        const nameRegex = /^[A-Za-z0-9\-]+$/;

                let errors = [];
        let errorElements = [];
        let fileMissing = false;
        
        const elDisplayName = document.getElementById('upload-display-name');
        const elDescription = document.getElementById('upload-description');
        const elParamGroup = document.getElementById('upload-param-scale');
        const elDropzone = document.getElementById('upload-dropzone');
        const elInMods = document.getElementById('upload-in-modalities');
        const elOutMods = document.getElementById('upload-out-modality');

        if (!selectedFile) {
          fileMissing = true;
          if (elDropzone) errorElements.push(elDropzone);
        }
        if (displayName.length < 3 || displayName.length > 50 || !nameRegex.test(displayName)) {
          errors.push(t('upload.displayName') || '模型显示名称');
          if (elDisplayName) errorElements.push(elDisplayName);
        }
        if (!paramScale) {
          errors.push(t('upload.paramScale') || '模型参数量级');
          if (elParamGroup) errorElements.push(elParamGroup);
        }
        if (inMods.length === 0) {
          errors.push(t('upload.inModalities') || '支持的输入模态');
          if (elInMods) errorElements.push(elInMods);
        }
        if (!outMod) {
          errors.push(t('upload.outModality') || '产生的输出模态');
          if (elOutMods) errorElements.push(elOutMods);
        }
        if (description.length === 0) {
          errors.push((t('upload.description') || '模型简介 / 描述') + (window.i18n && window.i18n.getLocale() === 'en' ? ' (Required)' : ' (未填写)'));
          if (elDescription) errorElements.push(elDescription);
        } else if (description.length < 20 || description.length > 200) {
          errors.push((t('upload.description') || '模型简介 / 描述') + (window.i18n && window.i18n.getLocale() === 'en' ? ' (Insufficient characters)' : ' (字数不足)'));
          if (elDescription) errorElements.push(elDescription);
        }

        if (fileMissing || errors.length > 0) {
          let msg = '';
          const isEn = window.i18n && window.i18n.getLocale() === 'en';
          
          if (fileMissing) {
            msg += isEn ? 'Model file cannot be empty. ' : '模型不能为空。';
          }
          if (errors.length > 0) {
            msg += (isEn ? 'Please check required fields: ' : '请检查表单中的必填项：') + errors.join('，');
          }
          
          localToast(msg, 'error');
          errorElements.forEach(el => {
            el.classList.remove('error-flash');
            void el.offsetWidth;
            el.classList.add('error-flash');
          });
          return;
        }

        // Real upload logic
        const metadata = {
          file_name: selectedFile.name,
          file_size: selectedFile.size,
          display_name: displayName,
          param_scale: paramScale,
          in_modalities: JSON.stringify(inMods),
          out_modality: outMod,
          capability_tags: JSON.stringify(Array.from(document.querySelectorAll('#upload-capability-tags input:checked')).map(cb => cb.value)),
          context_window: contextWindow,
          description: description
        };

        uploadSubmitBtn.disabled = true;
        uploadSubmitBtn.textContent = 'Initializing...';

        (async () => {
          try {
            // 1. Init Upload
            const initRes = await fetch('/api/models/upload/init', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(metadata)
            });
            if (!initRes.ok) {
              const err = await initRes.text();
              throw new Error(err);
            }
            const initData = await initRes.json();
            const { uploadId, parts } = initData;

            // 2. Upload Parts
            const chunkSize = 64 * 1024 * 1024;
            let uploadedParts = [];
            
            for (let i = 0; i < parts.length; i++) {
              const url = parts[i];
              const partNumber = i + 1;
              const start = (partNumber - 1) * chunkSize;
              const end = Math.min(start + chunkSize, selectedFile.size);
              const blob = selectedFile.slice(start, end);

              const isEn = window.i18n && window.i18n.getLocale() === 'en'; uploadSubmitBtn.textContent = isEn ? 'Uploading part ' + partNumber + '/' + parts.length + '...' : '上传中 (Part ' + partNumber + '/' + parts.length + ')...';

              const putRes = await fetch(url, {
                method: 'PUT',
                body: blob
              });
              if (!putRes.ok) throw new Error('Failed to upload part ' + partNumber);
              const etag = putRes.headers.get('ETag');
              if (!etag) throw new Error('ETag missing from R2 response. Please ensure CORS rules expose the ETag header.');
              uploadedParts.push({ PartNumber: partNumber, ETag: etag.replace(/"/g, '') });
            }

            uploadSubmitBtn.textContent = 'Finalizing...';

            // 3. Complete Upload
            const compRes = await fetch('/api/models/upload/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uploadId, parts: uploadedParts })
            });
            if (!compRes.ok) throw new Error(await compRes.text());

            uploadOverlay.classList.remove('active');
            localToast(t('upload.submitSuccess') || 'Submitted for review', 'success');
            if (window.loadMyModels) window.loadMyModels();
            
          } catch(e) {
            console.error('Upload Error:', e);
            localToast('Upload Error: ' + e.message, 'error');
          } finally {
            uploadSubmitBtn.disabled = false;
            uploadSubmitBtn.textContent = t('upload.submit') || 'Submit';
          }
        })();
      });
    }


    const uploadDisplayName = document.getElementById('upload-display-name');
    if (uploadDisplayName) {
      uploadDisplayName.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        const nameRegex = /^[A-Za-z0-9\-]+$/;
        if (val.length > 0 && (val.length < 3 || val.length > 50 || !nameRegex.test(val))) {
          e.target.classList.add('input-invalid');
        } else {
          e.target.classList.remove('input-invalid');
        }
      });
    }

    if (uploadDescription) {
      uploadDescription.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val.length > 0 && (val.length < 20 || val.length > 200)) {
          e.target.classList.add('input-invalid');
        } else {
          e.target.classList.remove('input-invalid');
        }
      });
    }
  }
});




window.updateUploadButtonState = function(pendingCount) {
  const btn = document.getElementById('btn-upload-model');
  if (!btn) return;
  if (pendingCount >= 3) {
    btn.disabled = true;
    btn.title = t('errorMaxPending') || 'Max 3 pending models allowed';
    btn.dataset.tooltip = t('errorMaxPending') || 'Max 3 pending models allowed';
  } else {
    btn.disabled = false;
    btn.title = '';
    btn.dataset.tooltip = '';
  }
};

window.deleteModel = function(id) {
  const isEn = window.i18n && window.i18n.getLocale() === 'en';
  
  if (window.showModal) {
    window.showModal(
      isEn ? 'Delete Model' : '删除模型',
      isEn ? 'Are you sure you want to delete this model? This action cannot be undone.' : '确定要删除这个模型吗？该操作无法恢复。',
      isEn ? 'Delete' : '确认删除',
      async () => {
        if (window.hideModal) window.hideModal();
        try {
          const res = await fetch(`/api/models/mine/${id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Delete failed');
          localToast(isEn ? 'Model deleted successfully' : '模型已成功删除', 'success');
          if (window.loadMyModels) window.loadMyModels();
        } catch(e) {
          localToast(e.message, 'error');
        }
      },
      true
    );
    
    setTimeout(() => {
      const btn = document.getElementById('modal-primary-btn');
      if (btn) {
        btn.style.backgroundColor = 'var(--error-color)';
        btn.style.borderColor = 'var(--error-color)';
        // clear styles when modal hides
        const overlay = document.getElementById('modal-overlay');
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
              if (!overlay.classList.contains('active')) {
                btn.style.backgroundColor = '';
                btn.style.borderColor = '';
                observer.disconnect();
              }
            }
          });
        });
        if (overlay) observer.observe(overlay, { attributes: true });
      }
    }, 10);
  }
};

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0.0 MB';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

window.loadMyModels = async function() {
  const tbody = document.getElementById('user-models-tbody');
  if (!tbody) return;
  
  try {
    const res = await fetch('/api/models/mine');
    if (!res.ok) return;
    const { models } = await res.json();
    
    let pendingCount = 0;
    let html = '';
    
    if (!models || models.length === 0) {
      html = `<tr><td colspan="4" style="text-align:center; padding:3rem; color:var(--text-muted);"><div style="font-size: 0.9rem;" data-i18n="models.empty">${t('models.empty')}</div></td></tr>`;
    } else {
      models.forEach(m => {
        if (m.status === 'pending') pendingCount++;
        
        let inMods = 'Text';
        try { const arr = JSON.parse(m.in_modalities); inMods = arr.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('+'); } catch(e){}
        const outMod = m.out_modality ? m.out_modality.charAt(0).toUpperCase() + m.out_modality.slice(1) : 'Text';
        const specPills = `<span class="models-spec-pill">${m.param_scale}</span><span class="models-spec-pill">${inMods}➔${outMod}</span>`;
        
        const ext = m.file_name ? m.file_name.split('.').pop().toUpperCase() : 'GGUF';
        const sizeStr = formatBytes(m.file_size);
        const date = m.created_at ? m.created_at.split(' ')[0] : '2026-10-05';
        const metaStr = `${ext} · ${sizeStr} · ${date}`;
        
        let usageHtml = '<span class="models-usage-dash">—</span>';
        if (m.status === 'published' || m.status === 'approved') {
          const calls = m.live_usage !== null ? m.live_usage : m.usage_count;
          const rating = m.live_rating !== null ? m.live_rating : m.user_rating;
          usageHtml = `<div class="models-usage-stats"><span class="models-usage-count"><span class="models-usage-num">${calls}</span> <span data-i18n="settings.models.calls">${t('settings.models.calls')}</span></span><span class="models-usage-rating">★ ${parseFloat(rating).toFixed(1)}</span></div>`;
        }
        
        let statusHtml = '';
        let actionHtml = '';
        if (m.status === 'pending') {
          statusHtml = `<span class="models-status models-status-pending"><span class="models-status-dot"></span><span data-i18n="settings.models.statusPending">${t('settings.models.statusPending')}</span></span>`;
          actionHtml = `<button class="models-action-btn models-action-delete" title="Delete" onclick="window.deleteModel('${m.upload_id}')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
        } else if (m.status === 'rejected') {
          statusHtml = `<span class="models-status models-status-rejected"><span class="models-status-dot"></span><span data-i18n="statusRejected">${t('statusRejected')}</span></span>`;
          actionHtml = `<button class="models-action-btn models-action-delete" title="Delete" onclick="window.deleteModel('${m.upload_id}')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
        } else if (m.status === 'approved') {
          statusHtml = `<span class="models-status models-status-published"><span class="models-status-dot" style="background:#0ea5e9;"></span><span data-i18n="settings.models.statusApproved">${t('settings.models.statusApproved')}</span></span>`;
          actionHtml = `<div class="models-action-locked-wrapper"><button class="models-action-btn models-action-locked" disabled><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></button><div class="models-tooltip" data-i18n="settings.models.tooltipLocked">${t('settings.models.tooltipLocked')}</div></div>`;
        } else if (m.status === 'published') {
          statusHtml = `<span class="models-status models-status-published"><span class="models-status-dot"></span><span data-i18n="settings.models.statusPublished">${t('settings.models.statusPublished')}</span></span>`;
          actionHtml = `<div class="models-action-locked-wrapper"><button class="models-action-btn models-action-locked" disabled><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></button><div class="models-tooltip" data-i18n="settings.models.tooltipLocked">${t('settings.models.tooltipLocked')}</div></div>`;
        }
        
        html += `<tr>
          <td class="models-td-model">
            <div class="models-name-row" style="justify-content: flex-start; gap: 8px;"><span class="models-name">${m.display_name}</span>${specPills}</div>
            <div class="models-meta">${metaStr}</div>
          </td>
          <td class="models-td-usage">${usageHtml}</td>
          <td class="models-td-status">${statusHtml}</td>
          <td class="models-td-action">${actionHtml}</td>
        </tr>`;
      });
    }
    
    tbody.innerHTML = html;
    if (window.i18n && window.i18n.init) window.i18n.init();
    if (window.updateUploadButtonState) window.updateUploadButtonState(pendingCount);
  } catch(e) {
    console.error(e);
  }
};



// --- Recharge & Redeem Modal Logic ---
(function() {
  const rechargeOverlay = document.getElementById('recharge-modal-overlay');
  const giftInput = document.getElementById('recharge-gift-code-input');
  const promoInput = document.getElementById('recharge-promo-code-input');
  const submitBtn = document.getElementById('recharge-submit-btn');
  const btnText = document.getElementById('recharge-btn-text');
  const errorMsg = document.getElementById('recharge-error-msg');
  const errorText = document.getElementById('recharge-error-text');
  const closeBtn = document.getElementById('close-recharge-modal-btn');

  let rechargeState = {
    method: 'gift',
    submitting: false
  };

  window.openRechargeModal = function() {
    if (!rechargeOverlay) return;
    rechargeOverlay.style.display = 'flex';
    void rechargeOverlay.offsetWidth;
    rechargeOverlay.classList.add('active');
    if (errorMsg) errorMsg.style.display = 'none';
    if (giftInput) {
      giftInput.value = '';
      giftInput.classList.remove('recharge-shake');
      setTimeout(() => giftInput.focus(), 100);
    }
  };

  window.closeRechargeModal = function() {
    if (!rechargeOverlay) return;
    rechargeOverlay.classList.remove('active');
    setTimeout(() => {
      if (!rechargeOverlay.classList.contains('active')) {
        rechargeOverlay.style.display = 'none';
      }
    }, 200);
  };

  // Explicitly bind all recharge triggers in the DOM
  function bindRechargeTriggers() {
    const billingBtn = document.getElementById('billing-topup-btn');
    if (billingBtn) {
      billingBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.openRechargeModal();
      };
    }
    const menuBtn = document.getElementById('menu-topup-btn');
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = document.getElementById('user-menu');
        if (menu) menu.style.display = 'none';
        window.openRechargeModal();
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindRechargeTriggers);
  } else {
    bindRechargeTriggers();
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', window.closeRechargeModal);
  }

  if (rechargeOverlay) {
    rechargeOverlay.addEventListener('click', (e) => {
      if (e.target === rechargeOverlay) window.closeRechargeModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rechargeOverlay && rechargeOverlay.style.display === 'flex') {
      window.closeRechargeModal();
    }
  });

  // Gift Code Auto-Hyphenation Formatter (XXXX-XXXX-XXXX-XXXX)
  if (giftInput) {
    giftInput.addEventListener('input', () => {
      let val = giftInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
      val = val.replace(/O/g, '0').replace(/[IL]/g, '1');
      if (val.length > 16) val = val.slice(0, 16);
      
      const parts = [];
      for (let i = 0; i < val.length; i += 4) {
        parts.push(val.slice(i, i + 4));
      }
      giftInput.value = parts.join('-');
      if (errorMsg) errorMsg.style.display = 'none';
      giftInput.classList.remove('recharge-shake');
    });

    giftInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRedeemSubmit();
      }
    });
  }

  function showRechargeError(keyOrMsg) {
    if (!errorMsg || !errorText) return;
    const msg = (typeof t === 'function' ? t(keyOrMsg) : null) || keyOrMsg;
    errorText.textContent = msg;
    errorMsg.style.display = 'flex';
    if (giftInput) {
      giftInput.classList.remove('recharge-shake');
      void giftInput.offsetWidth;
      giftInput.classList.add('recharge-shake');
      giftInput.focus();
    }
  }

  async function handleRedeemSubmit() {
    if (rechargeState.submitting) return;
    const rawVal = giftInput ? giftInput.value.trim() : '';
    if (!rawVal) {
      showRechargeError('error.redeem.empty');
      return;
    }

    rechargeState.submitting = true;
    if (submitBtn) submitBtn.disabled = true;
    if (btnText) btnText.textContent = typeof t === 'function' ? t('recharge.btn.redeeming') : 'Redeeming...';

    try {
      const res = await fetch('/api/billing/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: rawVal })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showRechargeError(data.error || 'error.redeem.invalid');
        return;
      }

      // Success
      const successMsg = typeof t === 'function' 
        ? t('recharge.success', { amount: data.amount }) 
        : ('🎉 Redeemed +' + data.amount + ' ⚡!');
      
      if (typeof window.showToast === 'function') {
        window.showToast(successMsg, 'success');
      }

      // Update credit numbers across UI
      const newBal = data.newBalance;
      const el1 = document.getElementById('credits-display');
      if (el1) el1.textContent = newBal;
      const el2 = document.getElementById('dropdown-points');
      if (el2) el2.textContent = newBal;
      const el3 = document.getElementById('settings-points-display');
      if (el3) el3.textContent = newBal;

      // Refresh ledger list if it exists
      if (typeof window.loadLedger === 'function') {
        window.loadLedger('all', 1);
      }

      setTimeout(() => {
        window.closeRechargeModal();
        if (window.fetchNotifications) window.fetchNotifications();
      }, 350);

    } catch (err) {
      showRechargeError(err.message || 'Network error');
    } finally {
      rechargeState.submitting = false;
      if (submitBtn) submitBtn.disabled = false;
      if (btnText) btnText.textContent = typeof t === 'function' ? t('recharge.btn.redeem') : 'Redeem Now';
    }
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', handleRedeemSubmit);
  }
})();

/* ============================================================
   NOTIFICATION CENTER CLIENT MODULE
   ============================================================ */

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(dateString) {
  if (!dateString) return '';
  const now = new Date();
  const date = new Date(dateString.endsWith('Z') ? dateString : dateString.replace(' ', 'T') + 'Z');
  const seconds = Math.floor((now - date) / 1000);
  const isEn = typeof getLocale === 'function' ? getLocale() === 'en' : false;

  if (seconds < 60) {
    return isEn ? 'Just now' : '刚刚';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return isEn ? `${minutes}m ago` : `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return isEn ? `${hours}h ago` : `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return isEn ? 'Yesterday' : '昨天';
  }
  if (days < 7) {
    return isEn ? `${days}d ago` : `${days} 天前`;
  }
  return date.toISOString().split('T')[0];
}

function getNotificationIcon(n) {
  if (n.category === 'model' && (n.event_type === 'model_published' || n.event_type === 'model_approved')) {
    return {
      className: 'icon-success',
      svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>'
    };
  }
  if (n.category === 'model' && (n.event_type === 'model_rejected' || n.event_type === 'model_delisted')) {
    return {
      className: 'icon-error',
      svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
    };
  }
  if (n.event_type === 'low_balance' || n.category === 'quota') {
    return {
      className: 'icon-warn',
      svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
    };
  }
  if (n.category === 'task' && n.priority === 'urgent') {
    return {
      className: 'icon-error',
      svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
    };
  }
  if (n.category === 'billing') {
    return {
      className: 'icon-info',
      svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>'
    };
  }
  return {
    className: 'icon-info',
    svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
  };
}

let notifState = {
  items: [],
  unreadCount: 0,
  hasUrgentUnread: false,
  isOpen: false,
  currentFilter: 'all'
};

window.fetchNotifications = async function() {
  if (!user) return;
  try {
    const res = await fetch('/api/notifications?limit=15');
    if (!res.ok) return;
    const data = await res.json();
    notifState.items = data.items || [];
    notifState.unreadCount = data.unreadCount || 0;
    notifState.hasUrgentUnread = data.hasUrgentUnread || false;

    updateNotificationBadge();
    renderNotificationPopover();
  } catch (err) {
    console.error('fetchNotifications error:', err);
  }
};

function updateNotificationBadge() {
  const dot = document.getElementById('notif-dot');
  const btn = document.getElementById('notif-btn');
  if (!dot || !btn) return;

  if (notifState.unreadCount > 0) {
    dot.style.display = 'block';
    if (notifState.hasUrgentUnread) {
      dot.className = 'notif-dot urgent';
      btn.classList.add('shake');
      setTimeout(() => btn.classList.remove('shake'), 1300);
    } else {
      dot.className = 'notif-dot normal';
      btn.classList.remove('shake');
    }
  } else {
    dot.style.display = 'none';
    btn.classList.remove('shake');
  }
}

function renderNotificationPopover() {
  const listEl = document.getElementById('notif-popover-list');
  if (!listEl) return;
  const isEn = typeof getLocale === 'function' ? getLocale() === 'en' : false;

  if (notifState.items.length === 0) {
    listEl.innerHTML = `<div class="notif-empty">${isEn ? 'No notifications' : '暂无新消息'}</div>`;
    return;
  }

  let html = '';
  notifState.items.slice(0, 10).forEach(n => {
    const icon = getNotificationIcon(n);
    const title = (isEn ? (n.title_en || n.title_zh) : (n.title_zh || n.title_en)) || '';
    const body = (isEn ? (n.content_en || n.content_zh) : (n.content_zh || n.content_en)) || '';
    const timeStr = timeAgo(n.created_at);
    const unreadClass = n.is_read ? 'read' : `unread ${n.priority === 'urgent' ? 'urgent' : ''}`;

    html += `
      <div class="notif-item ${unreadClass}" data-id="${n.notification_id}" onclick="handleNotificationClick('${n.notification_id}')">
        <div class="notif-icon-wrap ${icon.className}">
          ${icon.svg}
        </div>
        <div class="notif-content-wrap">
          <div class="notif-head-row">
            <span class="notif-item-title">${escapeHtml(title)}</span>
            <span class="notif-item-time">${timeStr}</span>
          </div>
          <div class="notif-item-body">${escapeHtml(body)}</div>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;
}

window.handleNotificationClick = async function(id) {
  const notif = notifState.items.find(x => x.notification_id === id);
  if (!notif) return;

  // 1. Mark as read immediately
  if (!notif.is_read) {
    notif.is_read = 1;
    notifState.unreadCount = Math.max(0, notifState.unreadCount - 1);
    updateNotificationBadge();
    renderNotificationPopover();
    fetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
  }

  // 2. Close popover
  const popover = document.getElementById('notif-popover');
  if (popover) {
    popover.style.display = 'none';
    notifState.isOpen = false;
  }

  // 3. Deep link execution
  if (notif.action_type === 'route' && notif.action_payload) {
    try {
      const payload = JSON.parse(notif.action_payload);
      if (payload.modal === 'settings') {
        if (typeof window.openSettingsModal === 'function') {
          window.openSettingsModal(payload.tab || 'account');
        }
      } else if (payload.modal === 'recharge') {
        if (typeof window.openRechargeModal === 'function') {
          window.openRechargeModal();
        }
      }
    } catch (e) {
      console.error('Error executing notification route payload:', e);
    }
  }
};

window.markAllNotificationsRead = async function() {
  try {
    await fetch('/api/notifications/read-all', { method: 'POST' });
    notifState.items.forEach(n => n.is_read = 1);
    notifState.unreadCount = 0;
    notifState.hasUrgentUnread = false;
    updateNotificationBadge();
    renderNotificationPopover();
    if (window.loadMessagesTab) window.loadMessagesTab(notifState.currentFilter);
  } catch (err) {
    console.error('markAllNotificationsRead error:', err);
  }
};

// --- Settings Modal: "我的消息" Tab Controller ---
window.loadMessagesTab = async function(filter = notifState.currentFilter || 'all') {
  notifState.currentFilter = filter;
  const listEl = document.getElementById('settings-messages-list');
  if (!listEl) return;
  const isEn = typeof getLocale === 'function' ? getLocale() === 'en' : false;

  listEl.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-secondary);">${isEn ? 'Loading notifications...' : '正在加载消息...'}</div>`;

  try {
    const res = await fetch(`/api/notifications?filter=${encodeURIComponent(filter)}&limit=50`);
    if (!res.ok) throw new Error('Failed to load messages');
    const data = await res.json();
    const items = data.items || [];

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="settings-empty-state" style="padding:3rem 1rem;">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
          <div class="settings-empty-title" style="margin-top:12px;">${isEn ? 'No notifications found' : '暂无相关消息'}</div>
        </div>`;
      return;
    }

    let html = '';
    items.forEach(n => {
      const icon = getNotificationIcon(n);
      const title = (isEn ? (n.title_en || n.title_zh) : (n.title_zh || n.title_en)) || '';
      const body = (isEn ? (n.content_en || n.content_zh) : (n.content_zh || n.content_en)) || '';
      const timeStr = timeAgo(n.created_at);
      const unreadClass = n.is_read ? 'read' : `unread ${n.priority === 'urgent' ? 'urgent' : ''}`;
      
      let badgeHtml = '';
      if (n.category === 'model') {
        badgeHtml = `<span class="settings-msg-badge" style="background:rgba(99,102,241,0.15); color:#818cf8;">${isEn ? 'Model' : '模型'}</span>`;
      } else if (n.category === 'billing' || n.category === 'quota') {
        badgeHtml = `<span class="settings-msg-badge" style="background:rgba(245,158,11,0.15); color:#fbbf24;">${isEn ? 'Billing' : '财务'}</span>`;
      } else if (n.category === 'system') {
        badgeHtml = `<span class="settings-msg-badge" style="background:rgba(16,185,129,0.15); color:#34d399;">${isEn ? 'System' : '系统'}</span>`;
      }

      let actionBtnHtml = '';
      if (n.action_type === 'route' && n.action_payload) {
        actionBtnHtml = `<button class="settings-message-action-btn" onclick="event.stopPropagation(); handleNotificationClick('${n.notification_id}')">${isEn ? 'View Details ➔' : '前往查看 ➔'}</button>`;
      }

      html += `
        <div class="settings-message-row ${unreadClass}" onclick="handleNotificationClick('${n.notification_id}')">
          <div class="notif-icon-wrap ${icon.className}">${icon.svg}</div>
          <div class="settings-msg-main">
            <div class="settings-msg-header-line">
              <span class="settings-msg-title">${escapeHtml(title)}</span>
              ${badgeHtml}
            </div>
            <div class="settings-msg-body">${escapeHtml(body)}</div>
          </div>
          <div class="settings-msg-side">
            <span class="settings-msg-time">${timeStr}</span>
            ${actionBtnHtml}
          </div>
        </div>
      `;
    });

    listEl.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--error-color);">${err.message}</div>`;
  }
};

// Initialize Notification Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  const notifBtn = document.getElementById('notif-btn');
  const notifPopover = document.getElementById('notif-popover');
  const markAllBtn = document.getElementById('notif-mark-all-btn');
  const messagesMarkAllBtn = document.getElementById('messages-mark-all-btn');
  const viewAllLink = document.getElementById('notif-view-all-link');

  if (notifBtn && notifPopover) {
    notifBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!user) {
        if (notifPopover) notifPopover.style.display = 'none';
        notifState.isOpen = false;
        window.showModal(
          t('chat.loginRequired'),
          `<p style="color:var(--text-secondary); line-height:1.6;">${t('chat.loginToUse')}</p>`,
          t('auth.goToLogin'),
          () => { window.location.href = '/login.html'; }
        );
        return;
      }
      notifState.isOpen = !notifState.isOpen;
      notifPopover.style.display = notifState.isOpen ? 'flex' : 'none';
      if (notifState.isOpen) {
        window.fetchNotifications();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#notif-dropdown-wrapper')) {
        notifPopover.style.display = 'none';
        notifState.isOpen = false;
      }
    });
  }

  if (markAllBtn) {
    markAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.markAllNotificationsRead();
    });
  }

  if (messagesMarkAllBtn) {
    messagesMarkAllBtn.addEventListener('click', () => {
      window.markAllNotificationsRead();
    });
  }

  if (viewAllLink) {
    viewAllLink.addEventListener('click', (e) => {
      e.stopPropagation();
      if (notifPopover) notifPopover.style.display = 'none';
      notifState.isOpen = false;
      if (typeof window.openSettingsModal === 'function') {
        window.openSettingsModal('messages');
      }
    });
  }

  // Filter pills inside "我的消息" panel
  document.querySelectorAll('#messages-filter-pills .messages-filter-pill, #messages-filter-pills .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#messages-filter-pills .messages-filter-pill, #messages-filter-pills .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      window.loadMessagesTab(pill.dataset.filter);
    });
  });

  // Initial fetch and 60-second periodic poll
  window.fetchNotifications();
  setInterval(window.fetchNotifications, 60000);
});

