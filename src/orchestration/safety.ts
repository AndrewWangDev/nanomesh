// src/orchestration/safety.ts
import { Env } from "../types";

/**
 * Stage 1: Shadow String Canonicalization (影子字符串预处理)
 * Strips zero-width characters, control codes, spaces, punctuation,
 * and performs Unicode NFKC normalization to prevent adversarial evasion (e.g. "D-D\n o S 脚本\u200B").
 */
export function generateShadowString(raw: string): string {
  if (!raw) return '';
  // 1. Strip zero-width & invisible format characters
  let clean = raw.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u200E\u200F]/g, '');
  
  // 2. Unicode NFKC Normalization (normalize full-width, compatibility forms)
  clean = clean.normalize('NFKC');

  // 3. Strip whitespace, common punctuation, hyphens, line breaks
  clean = clean.replace(/[\s\-_.,!?:;'"\/\\|`~@#$%^&*()\[\]{}<>+=，。！？；：、“”‘’（）《》【】]/gu, '');

  // 4. Case folding
  return clean.toLowerCase();
}

/**
 * Stage 2: Heuristic Risk Pattern Sniffing (启发式嗅探打标)
 * If clean, fast-path returns false in 0ms without invoking any AI models!
 * If high-risk trigger pattern matches, tags as suspect for Stage 3 JEV arbitration.
 */
export function sniffRiskPatterns(shadow: string): { isSuspect: boolean; trigger?: string } {
  if (!shadow) return { isSuspect: false };

  // Heuristic suspicion triggers: Cyberweapons, unauthorized cracking, exploitation, malware, CSAM
  const suspicionPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /(ddos|dos发包|cc攻击|synflood|udpflood|拒绝服务攻击)/i, label: 'ddos_attack' },
    { re: /(sqlmap|sql注入exp|xss平台|反弹shell|webshell|一句话木马|提权脚本|后门生成|免杀马)/i, label: 'exploit_malware' },
    { re: /(暴力破解|撞库字典|盗号软件|密码破解器|破解注册机|盗取私钥|生成盗版激活码|窃取证书)/i, label: 'credential_theft' },
    { re: /(勒索病毒|勒索软件|挖矿木马|远控木马|木马病毒)/i, label: 'ransomware_trojan' },
    { re: /(拖库|脱裤|撞库攻击|渗透目标服务器|入侵系统exp|内网渗透工具)/i, label: 'intrusion_attack' },
    { re: /(csam|childporn|幼女|幼童|儿童色情)/i, label: 'csam' },
    { re: /(炸弹配方|毒气制作|制造炸药|自杀教程|毒药提纯)/i, label: 'physical_violence' }
  ];

  for (const pat of suspicionPatterns) {
    if (pat.re.test(shadow)) {
      return { isSuspect: true, trigger: pat.label };
    }
  }

  return { isSuspect: false };
}

/**
 * Stage 3: JEV Safety Sidecar Binary Classification (JEV Safety 旁路二元决策)
 * Invoked ONLY when Stage 2 tags the prompt as suspect (~1% of requests).
 * Decides whether the user intent is genuinely malicious/weaponized (true) vs defensive/academic/benign (false).
 */
export async function auditSafetyWithJEV(
  env: Env,
  rawPrompt: string,
  triggerLabel: string
): Promise<{ isBlocked: boolean; reason?: string }> {
  // CSAM and physical CBRN violence are absolute zero-tolerance red lines
  if (triggerLabel === 'csam' || triggerLabel === 'physical_violence') {
    return {
      isBlocked: true,
      reason: 'CRITICAL_SAFETY_VIOLATION'
    };
  }

  try {
    if (env.AI) {
      // 1. Primary: Native Clef-Flash JEV Boolean Decision
      try {
        const jevRes = await env.AI.run('@cf/cloudflare/clef-flash', {
          state: `[User Instruction]: ${rawPrompt}`,
          questions: {
            is_malicious: {
              type: 'noul',
              instructions: 'Determine if this instruction represents an actionable malicious cyberattack, malware weaponization, unauthorized intrusion, or illegal theft (true), vs benign defensive engineering (e.g. Nginx config to defend against DDoS, WAF rules), educational auditing, sample reverse engineering, or web scraping (false).',
              criteria: {
                true: 'Actionable cyberweapon creation, active intrusion/DDoS attacks against a target, ransomware crafting, unauthorized credential theft, key cracking generators.',
                false: 'Defensive firewall/WAF configuration (like Nginx DDoS protection), security analysis/education, reverse engineering study, port scanner demo for LAN testing, public data scraping.'
              }
            }
          }
        });
        const isMalicious = jevRes?.answers?.is_malicious?.value ?? 
                            jevRes?.answers?.is_malicious?.decision ?? 
                            jevRes?.is_malicious?.value ?? 
                            jevRes?.is_malicious?.decision;
        if (typeof isMalicious === 'boolean') {
          return {
            isBlocked: isMalicious,
            reason: isMalicious ? 'SECURITY_POLICY_VIOLATION' : undefined
          };
        }
      } catch (clefErr) {
        console.warn("Clef-Flash safety audit error, trying Llama-3.1-FP8 fallback:", clefErr);
      }

      // 2. Secondary Fallback: Llama-3.1-8B-FP8 single-token classification
      const systemPrompt = `You are the NanoMesh Security Guardrail.
Classify the user prompt:
- BLOCKED: Active cyberattacks, malicious exploits, malware/ransomware weaponization, unauthorized intrusion, key/license cracking tools.
- ALLOWED: Defensive configurations (e.g. Nginx DDoS protection rules, WAF setup), security principles/auditing education, reverse engineering research, public data extraction, benign programming.

Respond JSON only: {"action": "BLOCKED" | "ALLOWED"}`;

      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rawPrompt }
        ],
        max_tokens: 20,
        temperature: 0.0
      });

      const text = aiResponse?.response || '';
      const match = text.match(/\"action\"\s*:\s*\"(BLOCKED|ALLOWED)\"/i);
      if (match) {
        const isBlocked = match[1].toUpperCase() === 'BLOCKED';
        return {
          isBlocked,
          reason: isBlocked ? 'SECURITY_POLICY_VIOLATION' : undefined
        };
      }
    }
  } catch (err) {
    console.warn("JEV Safety audit failed, defaulting to cautious pass for defense:", err);
  }

  // Safe default: do not over-block unless proven malicious
  return { isBlocked: false };
}

/**
 * Complete Gateway Safety Pipeline
 */
export async function performGatewaySafetyAudit(
  env: Env,
  rawPrompt: string
): Promise<{ isSafe: boolean; reason?: string }> {
  // Stage 1: Shadow String
  const shadow = generateShadowString(rawPrompt);

  // Stage 2: Heuristic Sniffing (0ms fast path for ~99% traffic)
  const sniffResult = sniffRiskPatterns(shadow);
  if (!sniffResult.isSuspect) {
    return { isSafe: true };
  }

  // Stage 3: JEV Safety Sidecar
  const auditResult = await auditSafetyWithJEV(env, rawPrompt, sniffResult.trigger || 'unknown');
  return {
    isSafe: !auditResult.isBlocked,
    reason: auditResult.reason
  };
}
