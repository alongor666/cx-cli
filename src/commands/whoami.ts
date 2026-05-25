/**
 * cx whoami
 * 显示当前 PAT 对应的用户与角色
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';

interface MeResp {
  success: boolean;
  data: { username: string; displayName: string; role: string; organization?: string };
}

export async function whoamiCommand(): Promise<void> {
  try {
    const me = await cxGet<MeResp>('/api/auth/me');
    const d = me.data;
    console.log(kleur.cyan('Username:    '), d.username);
    console.log(kleur.cyan('Display:     '), d.displayName);
    console.log(kleur.cyan('Role:        '), d.role);
    if (d.organization) console.log(kleur.cyan('Organization:'), d.organization);
  } catch (err) {
    if (err instanceof CxApiError) {
      console.error(kleur.red(`✘ ${err.message}`));
    } else {
      console.error(kleur.red(`✘ ${(err as Error).message}`));
    }
    process.exit(1);
  }
}
