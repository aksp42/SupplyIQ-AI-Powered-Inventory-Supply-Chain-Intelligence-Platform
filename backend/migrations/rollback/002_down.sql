-- ============================================================================
-- 002_reference_data — rollback
-- Only removes the platform reference rows. Any business data that was created
-- using these permissions/roles is left untouched; it simply loses its label.
-- ============================================================================
USE supplyiq;

DELETE rp FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id WHERE r.organization_id IS NULL;
DELETE FROM roles      WHERE organization_id IS NULL;
DELETE FROM permissions;
DELETE FROM reports;