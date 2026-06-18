import { describe, it, expect } from 'vitest';
import { resolveBatchRoute } from '../commands/batch.js';
import type { RouteMeta } from '../commands/routes.js';

const CATALOG: RouteMeta[] = [
  { key: 'KPI', path: '/kpi', fullPath: '/api/query/kpi', summary: '', description: '', tags: [], parameters: [] },
  { key: 'CLAIMS_DETAIL_HEATMAP', path: '/claims-detail/heatmap', fullPath: '/api/query/claims-detail/heatmap', summary: '', description: '', tags: [], parameters: [] },
];

describe('resolveBatchRoute', () => {
  describe('catalog key（非 / 开头）', () => {
    it('key 宽容匹配', () => {
      expect(resolveBatchRoute('KPI', CATALOG)).toEqual({ fullPath: '/api/query/kpi' });
      expect(resolveBatchRoute('kpi', CATALOG)).toEqual({ fullPath: '/api/query/kpi' });
      expect(resolveBatchRoute('claims-detail-heatmap', CATALOG)).toEqual({ fullPath: '/api/query/claims-detail/heatmap' });
    });

    it('未命中 catalog 返回 null', () => {
      expect(resolveBatchRoute('UNKNOWN_KEY', CATALOG)).toBeNull();
    });

    it('catalog 为 null 时返回 null（让上层走 resolveWithRefresh）', () => {
      expect(resolveBatchRoute('KPI', null)).toBeNull();
    });
  });

  describe('/api/* 顶层 API path（直通）', () => {
    it('/api/query/* 直通', () => {
      expect(resolveBatchRoute('/api/query/kpi', CATALOG)).toEqual({ fullPath: '/api/query/kpi' });
    });
    it('/api/data/* 直通（不走 catalog 包装）', () => {
      expect(resolveBatchRoute('/api/data/version', CATALOG)).toEqual({ fullPath: '/api/data/version' });
    });
    it('/api/auth/* 直通', () => {
      expect(resolveBatchRoute('/api/auth/route-catalog', CATALOG)).toEqual({ fullPath: '/api/auth/route-catalog' });
    });
    it('catalog 为 null 时仍直通', () => {
      expect(resolveBatchRoute('/api/data/version', null)).toEqual({ fullPath: '/api/data/version' });
    });
  });

  describe('/ 开头的 catalog path（包装到 fullPath）', () => {
    it('/kpi 包装为 /api/query/kpi', () => {
      expect(resolveBatchRoute('/kpi', CATALOG)).toEqual({ fullPath: '/api/query/kpi' });
    });
    it('/claims-detail/heatmap 包装为完整 catalog fullPath', () => {
      expect(resolveBatchRoute('/claims-detail/heatmap', CATALOG)).toEqual({ fullPath: '/api/query/claims-detail/heatmap' });
    });
  });

  describe('/ 开头但 catalog 未登记的顶层 path（顶层直通 — 修复 /health bug）', () => {
    it('/health 直通顶层，不再错误包装为 /api/query/health', () => {
      expect(resolveBatchRoute('/health', CATALOG)).toEqual({ fullPath: '/health' });
    });
    it('未在 catalog 的非 /api/ 路径直通', () => {
      expect(resolveBatchRoute('/metrics', CATALOG)).toEqual({ fullPath: '/metrics' });
    });
    it('catalog 为 null 时 / 路径直通顶层', () => {
      expect(resolveBatchRoute('/health', null)).toEqual({ fullPath: '/health' });
      expect(resolveBatchRoute('/kpi', null)).toEqual({ fullPath: '/kpi' });
    });
  });
});
