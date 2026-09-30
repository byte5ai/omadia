/**
 * Moving what a trust-era kernel created over to the restricted kernel role.
 *
 * Before the embedded Postgres asked for passwords, the kernel connected as
 * the bootstrap superuser, so every table, sequence, view, type, function and
 * schema it created is owned by that superuser. The restricted role has to own
 * them, or the kernel's later migrations fail with "must be owner of ...".
 *
 * `REASSIGN OWNED BY omadia` would be the one-liner, but Postgres refuses it
 * for the bootstrap superuser (2BP01: "required by the database system"), so
 * the objects are moved one kind at a time. Extension members stay with their
 * extension; indexes, owned sequences, row types and array types follow their
 * table or element type (Postgres moves those itself), and a multirange type
 * follows its range. Tables go before the sequence pass because an identity
 * sequence cannot be moved on its own. Idempotent: a second run finds nothing
 * left to move.
 */

/** Role names are interpolated into SQL, so only plain identifiers are accepted. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertPlainIdentifier(name: string): void {
  if (!PLAIN_IDENTIFIER.test(name)) throw new Error(`not a plain role name: ${JSON.stringify(name)}`);
}

/** A DO block that gives every non-extension object `from` owns in the current database to `to`. */
export function transferOwnershipSql(from: string, to: string): string {
  assertPlainIdentifier(from);
  assertPlainIdentifier(to);
  return `DO $transfer$
DECLARE
  boot oid := '${from}'::regrole;
  obj record;
BEGIN
  FOR obj IN
    SELECT n.oid, n.nspname FROM pg_namespace n
    WHERE n.nspowner = boot
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO ${to}', obj.nspname);
  END LOOP;

  FOR obj IN
    SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner = boot AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO ${to}',
      CASE obj.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      obj.oid::regclass);
  END LOOP;

  FOR obj IN
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner = boot AND c.relkind = 'S'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'i'))
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO ${to}', obj.oid::regclass);
  END LOOP;

  FOR obj IN
    SELECT t.oid, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typowner = boot AND t.typtype IN ('b', 'c', 'd', 'e', 'r')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
      AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_type a WHERE a.typarray = t.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO ${to}',
      CASE obj.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, obj.oid::regtype);
  END LOOP;

  FOR obj IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proowner = boot
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ${to}', obj.oid::regprocedure);
  END LOOP;
END
$transfer$`;
}
