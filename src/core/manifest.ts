import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ManifestParseResult, RolesManifest } from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

const roleSchema = z.object({
  id: z.string().regex(ID_RE, 'id must match ^[a-z0-9][a-z0-9_-]*$'),
  description: z.string().optional(),
  namespaces: z.array(z.string().regex(ID_RE, 'namespace must match ^[a-z0-9][a-z0-9_-]*$')),
});

const manifestSchema = z
  .object({
    version: z.number(),
    roles: z.array(roleSchema),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    for (const role of val.roles) {
      if (seen.has(role.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles'],
          message: `duplicate role id "${role.id}"`,
        });
      }
      seen.add(role.id);
    }
  });

export function parseRolesManifest(checkoutRoot: string): ManifestParseResult {
  const filePath = join(checkoutRoot, 'manifest', 'roles.yaml');
  if (!existsSync(filePath)) return { manifest: null };

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    return { manifest: null, error: `Cannot read roles manifest (${filePath}): ${(e as Error).message}` };
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    return { manifest: null, error: `Invalid YAML in roles manifest (${filePath}): ${(e as Error).message}` };
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { manifest: null, error: `Roles manifest root must be a mapping (${filePath})` };
  }

  const parsed = manifestSchema.safeParse(doc);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ');
    return { manifest: null, error: `Invalid roles manifest (${filePath}): ${reasons}` };
  }

  return { manifest: parsed.data };
}

export function namespacesForRoles(
  manifest: RolesManifest,
  roleIds: string[],
): { namespaces: string[]; unknownRoles: string[] } {
  const byId = new Map(manifest.roles.map((r) => [r.id, r]));
  const namespaces: string[] = [];
  const seenNs = new Set<string>();
  const unknownRoles: string[] = [];
  const seenUnknown = new Set<string>();

  for (const id of roleIds) {
    const role = byId.get(id);
    if (!role) {
      if (!seenUnknown.has(id)) {
        seenUnknown.add(id);
        unknownRoles.push(id);
      }
      continue;
    }
    for (const ns of role.namespaces) {
      if (!seenNs.has(ns)) {
        seenNs.add(ns);
        namespaces.push(ns);
      }
    }
  }

  return { namespaces, unknownRoles };
}
