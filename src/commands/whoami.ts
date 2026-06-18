/**
 * cx whoami
 * 显示当前 PAT 对应的用户、角色、数据范围与本地配置
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { loadConfig } from '../config.js';
import { failWith } from '../exit-codes.js';

interface MeResp {
  success: boolean;
  data: {
    username: string;
    displayName: string;
    role: string;
    organization?: string;
    dataScope?: string;
    tokenType?: string;
    allowedRoutes?: string[];
  };
}

export async function whoamiCommand(): Promise<void> {
  try {
    const me = await cxGet<MeResp>('/api/auth/me');
    const d = me.data;
    const cfg = loadConfig();
    console.log(kleur.cyan('Username:    '), d.username);
    console.log(kleur.cyan('Display:     '), d.displayName);
    console.log(kleur.cyan('Role:        '), d.role);
    if (d.organization) console.log(kleur.cyan('Organization:'), d.organization);
    if (d.dataScope) console.log(kleur.cyan('DataScope:   '), d.dataScope);
    console.log(kleur.cyan('TokenType:   '), d.tokenType ?? 'pat');
    if (cfg.tokenId) console.log(kleur.cyan('TokenId:     '), cfg.tokenId);
    console.log(kleur.cyan('BaseUrl:     '), cfg.baseUrl);
  } catch (err) {
    failWith(err);
  }
}
