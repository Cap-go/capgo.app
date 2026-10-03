# Request Manifest Upload

**Date:** 2026-10-02

**Status:** Accepted design; implementation is split across the API, files
service, and CLI pull requests

**Scope:** CLI delta-manifest upload preparation, server-selected R2 paths,
short-lived upload capabilities, and compatibility with the existing TUS and
`set_manifest` flows

**Related:**
[R2 Delta Manifest Object Lifecycle](2026-09-30-r2-manifest-object-lifecycle-design.md)

---

## 1. Summary

Add an authenticated endpoint:

```text
POST /private/request_manifest_upload
```

The CLI calls it after creating the `app_versions` row and before probing or
uploading any delta objects. The request contains the version ID and the complete
logical manifest, including the hashes and sizes calculated by the CLI. The
backend authorizes the operation once, derives every physical R2 path, and
returns short-lived capabilities that authorize uploads to those exact paths.

The endpoint does not reserve objects, query R2, decide whether an object
exists, or persist manifest rows. In protocol version 1 every entry uses the
default action `upload_if_doesnt_exist`. The CLI remains responsible for the
existing object probe, TUS upload, receipt collection, and final
`POST /private/set_manifest` call.

The upload capability replaces the API-key and database authorization work on
capability-bearing TUS requests. It does not replace normal API-key
authentication elsewhere and does not change the existing path for published
CLIs.

This is a narrower protocol than the reservation system proposed in the R2
object-lifecycle document. It centralizes path selection and removes repeated
database authorization from uploads, but it does not by itself solve the
upload-versus-deletion race. Deterministic legacy objects must remain protected
by the lifecycle policy described there.

## 2. Goals and non-goals

### Goals

- Authorize one complete manifest with one bounded database operation.
- Make the backend authoritative for `owner_org`, `app_id`, and physical R2
  paths.
- Preserve the current deterministic path layout initially.
- Allow `/files/upload/attachments` to validate an exact-path capability
  without querying PostgreSQL or Supabase Auth.
- Keep response growth linear and explicitly capped for expected 5,000-file
  bundles and the existing hard 10,000-entry manifest limit, without repeating
  shared or request-owned data per entry.
- Keep the upload URL and protocol server-controlled instead of hard-coded in
  the CLI.
- Leave room for future `reuse` and unconditional `upload` decisions without
  requiring a breaking response change.
- Preserve the existing signed manifest-size receipt and `set_manifest`
  behavior.

### Non-goals

- No object reservation or lifecycle-table write.
- No R2 `HEAD`, `GET`, or `LIST` operation in this endpoint.
- No guarantee that `uploaded_bytes_sha256`, `uploaded_bytes_size`, or
  `file_hash` matches uploaded content in protocol version 1.
- No manifest persistence or bundle finalization.
- No change to native iOS or Android download behavior.
- No removal or behavior change for the existing API-key-authorized upload
  path.
- No safe physical deletion of reusable deterministic objects.

## 3. Endpoint authentication and authorization

`POST /private/request_manifest_upload` must reuse the existing private API-key
authentication and attachment-upload authorization helpers. It must not
implement another API-key parser, identity lookup, RBAC model, app lookup, or
plan calculation.

Concretely, the route starts with the existing
`middlewareKey({ usePostgres: true, readOnly: false, rateLimitScope: 'upload' })`,
uses the auth context it creates, uses the existing `checkPermissionPg` helper,
and shares the existing attachment-upload eligibility logic currently used by
`checkWriteAppAccess`. If necessary, that logic should be extracted into one
reusable helper rather than copied into the new endpoint.

The shared authorization path performs the checks that a later
capability-bearing upload will intentionally skip:

1. Authenticate the API key and resolve the caller identity through
   `middlewareKey`.
2. Load the requested `app_versions` row from the primary database.
3. Verify `app.upload_bundle` permission for the version's `app_id`.
4. Load the owning app and take `owner_org` and `app_id` from server-side data.
5. Apply the existing attachment hosted-upload eligibility gate, including the
   current `getAppByIdPg(..., ATTACHMENT_PLAN_LIMIT)` result and
   `onPremiseAppResponse` behavior.
6. Reject deleted versions.
7. Require `storage_provider = 'r2-direct'`.
8. If delta-file encryption is enabled in the request, require a nonempty
   `app_versions.session_key`.

The request schema is strict. It does not accept `owner_org`, `app_id`,
`s3_path`, `s3_path_prefix`, `iv_session_key`, or `iv_session_key_hex` at all.
Their presence is a `400 error_manifest_upload_request_invalid`; these fields
are not silently ignored and never participate in authorization or path
selection.

The endpoint uses one primary-database connection for the bounded version/app
lookup, permission check, and existing eligibility check. It performs no
service-role Supabase SDK authorization and no per-entry database lookup.

An inaccessible and a nonexistent version should use the same externally
observable error so the endpoint does not become a version-existence oracle.

## 4. Request contract

### 4.1 Example

```http
POST /private/request_manifest_upload HTTP/1.1
Authorization: <existing Capgo API key>
Content-Type: application/json
Accept-Encoding: br, gzip
```

```json
{
  "protocol_version": 1,
  "version_id": 12345,
  "delta_encryption": {
    "enabled": true
  },
  "manifest_upload_auto_enabled": false,
  "file_hash_format": "rsa_v3_hex",
  "entries": [
    {
      "id": 0,
      "file_name": "index.html.br",
      "compression": "brotli",
      "file_hash": "<512 lowercase hexadecimal characters>",
      "uploaded_bytes_sha256": "<64 lowercase hexadecimal characters>",
      "uploaded_bytes_size": 4812
    },
    {
      "id": 1,
      "file_name": "assets/logo.png",
      "compression": "none",
      "file_hash": "<512 lowercase hexadecimal characters>",
      "uploaded_bytes_sha256": "<64 lowercase hexadecimal characters>",
      "uploaded_bytes_size": 19342
    }
  ]
}
```

### 4.2 Top-level fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `protocol_version` | integer | yes | Must be `1`. It versions this contract independently from CLI releases. |
| `version_id` | positive safe integer | yes | Existing `app_versions.id`, created before this request. |
| `delta_encryption.enabled` | boolean | yes | Whether the individual delta objects, rather than merely the full ZIP, are encrypted. |
| `manifest_upload_auto_enabled` | boolean | yes | Whether manifest upload was enabled implicitly and full-ZIP upload is enabled as a permitted fallback. |
| `file_hash_format` | enum | yes | Encoding used by every entry's `file_hash`. |
| `entries` | array | yes | Complete logical manifest. It must contain 1 through 10,000 entries. |

`delta_encryption.enabled` deliberately describes delta-file encryption. A
version can have a stored `session_key` because its full ZIP is encrypted while
its delta objects remain unencrypted for compatibility with an older installed
updater.

`manifest_upload_auto_enabled` is `true` only when both conditions hold:

- the user did not explicitly request manifest/delta upload; and
- full ZIP upload is enabled, so the CLI may complete the version as ZIP-only
  if manifest upload is explicitly abandoned.

If full ZIP upload is disabled, manifest upload is required and the CLI always
sends `manifest_upload_auto_enabled: false`, regardless of how manifest mode was
selected. The backend signs this bit into every upload capability so the files
endpoint can choose the permitted failure mode without trusting an unsigned
request header.

### 4.3 Entry fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes | Request-local identifier. IDs must be unique; contiguous values from `0` are recommended. |
| `file_name` | string | yes | Final logical manifest path relative to the bundle root. It includes the `.br` suffix when Brotli bytes are uploaded. This is both a filename and a relative path; there is no separate `file_path` field. |
| `compression` | `none \| brotli` | yes | Transformation applied before optional encryption. |
| `file_hash` | string | yes | Existing hash or RSA signature representation consumed by the updater for logical-file verification. It is not necessarily a SHA-256 digest once delta encryption is enabled. |
| `uploaded_bytes_sha256` | string | yes | Newly calculated lowercase SHA-256 hex of the exact raw payload bytes sent to TUS/R2, after optional compression and optional encryption. It is always sent, even when it equals `file_hash`. |
| `uploaded_bytes_size` | nonnegative safe integer | yes | Number of exact bytes sent to TUS. It is advisory in protocol version 1. |

`file_hash` and `uploaded_bytes_sha256` are intentionally separate:

- `file_hash` preserves the updater's existing logical-file verification
  contract;
- `uploaded_bytes_sha256` describes the physical bytes written to R2. Here,
  "raw upload bytes" means the final TUS body, not the original source file;
- protocol version 1 validates their syntax but does not compare either value
  with the uploaded body.

### 4.4 Hash formats

`file_hash_format` has these protocol-version-1 values:

| Value | Required `delta_encryption.enabled` | Validation |
| --- | --- | --- |
| `sha256_hex` | `false` | Exactly 64 lowercase hexadecimal characters. |
| `rsa_v2_base64` | `true` | Canonical padded base64 for the existing legacy 2048-bit RSA representation; exactly 344 characters. |
| `rsa_v3_hex` | `true` | Exactly 512 lowercase hexadecimal characters. |

The backend rejects a format that does not agree with
`delta_encryption.enabled`. It hashes the exact validated textual
representation; it does not decode and re-encode `file_hash` before path
derivation.

### 4.5 Filename validation

The existing `/files/upload/attachments` validation does not validate this
logical `file_name`. It validates the already-derived physical attachment key,
principally that it has a nonempty `orgs/{owner_org}/apps/{app_id}/...` shape.
`set_manifest` currently checks that `file_name` is present and within its
existing maximum length, while the current CLI derives it from a local relative
path and separately rejects spaces. The new endpoint therefore needs explicit
logical-name validation before it derives a physical path.

`file_name` must:

- be a nonempty relative POSIX path;
- satisfy the existing shared `MAX_FILE_NAME_LENGTH` limit, currently 2,048
  JavaScript string characters;
- contain no NUL, backslash, leading slash, empty segment, `.` segment, or `..`
  segment;
- be unique within the request;
- end in `.br` exactly when `compression = 'brotli'`.

The server preserves the input Unicode bytes and applies URI encoding to each
path segment. It does not apply an implicit Unicode normalization that could
make its path differ from the CLI's manifest path.

The endpoint must reuse shared constants for the existing manifest limits
instead of defining divergent copies. The current limits include 10,000
entries, a 2,048-character `file_name`, a 512-character `file_hash`, and a
2,048-character final `s3_path`. Hash-format validation is stricter than the
existing generic 512-character maximum where applicable.

## 5. Server-side path derivation

For its initial responses, the endpoint must reproduce the exact path formula
currently implemented by the CLI. This is what "preserve the current CLI
layout" means: moving path calculation to the backend must not relocate
existing deterministic objects, prevent reuse, or create a second storage
namespace merely because the new endpoint was adopted. The response contract
does not hard-code this layout into the new CLI, so the backend can select a
different complete path later.

### 5.1 Shared prefix

For unencrypted delta objects:

```text
orgs/{owner_org}/apps/{app_id}/delta/
```

For encrypted delta objects:

```text
orgs/{owner_org}/apps/{app_id}/delta/{session_key_path_component}/
```

The endpoint reads `app_versions.session_key` from the database. That value is
stored in the existing form:

```text
{IV_BASE64}:{RSA_ENCRYPTED_SESSION_KEY_BASE64}
```

`session_key_path_component` is the lowercase hexadecimal encoding of the
UTF-8 bytes of that complete stored string:

```ts
hex(utf8(app_versions.session_key))
```

Despite the current CLI variable name, `iv_session_key_hex` is not an
independent value stored in the database. It is this derived path component.
The CLI does not send it to the endpoint.

### 5.2 Per-entry suffix

For every entry:

```text
filename_hash = hex(SHA-256(UTF-8(file_hash)))
encoded_file_name = file_name split on "/", with encodeURIComponent applied to each segment
s3_path_suffix = filename_hash + "_" + encoded_file_name
s3_path = s3_path_prefix + s3_path_suffix
```

The first hash is intentionally a SHA-256 of the `file_hash` string. It is not
a second hash of the file contents and it is not a hash of decoded RSA bytes.

The server rejects duplicate resulting `s3_path` values.

## 6. Response contract

### 6.1 Example

```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Encoding: br
```

```json
{
  "protocol_version": 1,
  "version_id": 12345,
  "default_action": "upload_if_doesnt_exist",
  "default_s3_path_prefix": "orgs/00000000-0000-0000-0000-000000000001/apps/com.example.app/delta/3c69764261736536343a656e637279707465644b6579426173653634/",
  "default_upload_target": "capgo_tus_v1",
  "upload_targets": [
    {
      "id": "capgo_tus_v1",
      "protocol": "tus",
      "upload_url": "https://files.example.invalid/files/upload/attachments/",
      "existence_check_url_prefix": "https://files.example.invalid/files/read/attachments/",
      "authorization": {
        "type": "header",
        "header_name": "X-Capgo-Upload-Token",
        "token_prefix": "v1.2026-10-a.1790957400.12345.0.",
        "expires_at": 1790957400
      }
    }
  ],
  "entries": [
    {
      "id": 0,
      "s3_path_suffix": "<64-character filename hash>_index.html.br",
      "upload_token": "<opaque upload token>"
    },
    {
      "id": 1,
      "s3_path_suffix": "<64-character filename hash>_assets/logo.png",
      "upload_token": "<opaque upload token>"
    }
  ]
}
```

The example host, organization, application, keys, and hashes are synthetic.

### 6.2 Response fields

| Field | Meaning |
| --- | --- |
| `protocol_version` | Response contract version. |
| `version_id` | Echo of the authorized version ID. |
| `default_action` | Action used when an entry omits `action`. Protocol version 1 always returns `upload_if_doesnt_exist`. |
| `default_s3_path_prefix` | Optional server-selected prefix used only by entries that return `s3_path_suffix`. |
| `default_upload_target` | ID of the target used when an entry omits `upload_target`. |
| `upload_targets` | Server-selected protocol, existence-check URL, upload URL, and authorization transport. Authorization belongs to the target rather than a separate top-level object. |
| `entries` | Compact response patch keyed by request-local `id`. Request fields are not echoed. |

Each response entry uses these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Matches exactly one request entry. |
| `action` | no | Overrides `default_action` for this entry. |
| `upload_target` | no | Overrides `default_upload_target` for this entry. |
| `s3_path` | exactly one path form | Complete server-selected physical path. |
| `s3_path_suffix` | exactly one path form | Suffix resolved against `default_s3_path_prefix`. |
| `upload_token` | when the resolved action can upload | Opaque per-entry token suffix concatenated after the resolved target authorization's opaque `token_prefix`. |
| `file_size_receipt` | when action is `reuse` | Existing signed size receipt needed by `set_manifest`. |

Each response entry contains exactly one physical-path representation:

```text
1. s3_path
   Use the complete server-provided path as-is.

2. s3_path_suffix
   Require default_s3_path_prefix and concatenate them exactly once.
```

The new CLI must support both representations from its first release, including
a response that mixes prefixed and complete paths across entries. The initial
backend implementation returns one `default_s3_path_prefix` and suffixes for
all entries because that is compact. A future backend may return a complete
`s3_path` for one or every entry without requiring the CLI to know why.

Likewise, an entry may override `default_upload_target` with `upload_target`.
Every referenced target ID must exist in `upload_targets`.

For an uploadable entry, the CLI constructs the authorization header value by
concatenating the resolved target's `authorization.token_prefix` and the
entry's `upload_token` exactly as returned:

```text
header value = token_prefix + upload_token
```

Both pieces are opaque transport values. The CLI must not split, decode,
validate, or measure either piece, and it must not assume HMAC, JWT, a signature
length, or any particular number of dot-separated components. It only performs
the declared concatenation and sends the result in
`authorization.header_name`. A future target may use a different prefix or
token representation without changing the manifest-entry logic.

This is the updated manifest projection. Returning a compact patch instead of
echoing the complete request avoids duplicating file names, hashes, sizes,
formats, target metadata, and the potentially very large encrypted path prefix
10,000 times. The shared token prefix appears once per upload target while only
the opaque signature suffix appears per entry. HTTP compression may reduce the
remaining JSON framing, but correctness must not depend on compression being
available.

The CLI must reject a response when:

- `version_id` or `protocol_version` differs from the request;
- an entry ID is missing, duplicated, or unknown;
- the response does not contain exactly one entry for every request entry;
- neither or both of `s3_path` and `s3_path_suffix` are present;
- a suffix is returned without `default_s3_path_prefix`;
- a returned complete path or resolved prefix-plus-suffix is not a valid
  normalized attachment path;
- a referenced upload target is missing;
- the resolved target has no authorization header name or token prefix;
- `upload_token` is missing for an uploadable action or cannot safely be used
  as an HTTP header value.

## 7. Action semantics

The action enum is:

```text
upload_if_doesnt_exist
reuse
upload
```

An entry may eventually override `default_action` with an `action` field.
The first CLI release that adopts this endpoint must implement all three action
values and reject unknown actions. The initial backend emits only
`upload_if_doesnt_exist`; implementing the other two in the CLI now makes their
later server-side activation a non-breaking change.

### `upload_if_doesnt_exist`

This is the only action emitted in protocol version 1.

1. Construct the full `s3_path`.
2. Use the existing CLI file-existence helper against the target's
   `existence_check_url_prefix`. Build its headers with the existing
   `buildCliRequestHeaders`, so the request includes `x-cli-version`. Probe
   method, range use, and cache behavior remain CLI/file-service implementation
   details and are not provided by this endpoint.
3. On a successful response, retain the returned manifest-size receipt and do
   not upload.
4. On a definitive `404`, perform the TUS upload.
5. Do not interpret authentication errors, rate limits, or transient 5xx
   responses as "missing"; retry or fail instead.

### `reuse`

Reserved for a future server-side existence or lifecycle decision. The CLI
skips both the existence check and upload. A future response using this action
must also provide a valid `file_size_receipt` so final `set_manifest` receipt
mode remains complete.

The initial backend never emits this action.

### `upload`

Reserved for a future instruction to skip the existence check and upload
immediately. It still requires an exact-path upload capability.

The initial backend never emits this action.

### Receipt behavior for CLI reads

Keep the existing `X-Capgo-Manifest-Size-Receipt` format and verification
behavior. Do not use the new upload-capability secret for receipts.

The file-read handler must attach a receipt on every successful attachment
`GET` or `HEAD` when either condition is true:

- the existing `nocache` query parameter is present; or
- a nonempty existing `x-cli-version` header is present.

This must also work for file-read cache hits. The receipt describes the complete
stored object's size. The header remains exposed through the existing CORS
response configuration.

The current CLI existence probe already calls `buildCliRequestHeaders`, which
adds `x-cli-version`; the new flow must preserve that helper rather than invent
an `X-Capgo-CLI-Version` variant. The CLI should continue sending `nocache`
during rollout for compatibility with backends that have not yet adopted the
header-based rule.

Normal iOS and Android update downloads do not send `x-cli-version`, and their
URLs do not normally include this CLI `nocache` probe. Their response bodies,
status codes, cache behavior, and headers therefore remain unchanged except in
the already-existing cases that requested a receipt.

## 8. Upload capability

### 8.1 Format

The initial backend implementation uses a compact HMAC token rather than a JWT.
One possible internal serialization is:

```text
v1.{key_id}.{expires_at_unix}.{version_id}.{manifest_upload_auto_enabled_bit}.{signature}
```

The bit is `1` when `manifest_upload_auto_enabled = true` and `0` otherwise.
The target-scoped `authorization.token_prefix` contains everything through the
final dot after that bit. Each entry's opaque `upload_token` contains the
signature suffix. This serialization remains a backend implementation detail:
the CLI concatenates the two returned strings and must not enforce a token
length or format.

HMAC-SHA-256 uses a new, dedicated random 256-bit secret loaded from
Vault-backed runtime configuration, for example
`MANIFEST_UPLOAD_CAPABILITY_SECRET`. It must not reuse
`MANIFEST_SIZE_RECEIPT_SECRET` or any Supabase/JWT secret. `key_id` supports
overlapping key rotation. The upload service verifies signatures with a
constant-time WebCrypto operation and never logs tokens or signatures.

### 8.2 Canonical signed payload

For each entry, sign these exact UTF-8 lines:

```text
capgo-manifest-upload:v1
{key_id}
{expires_at_unix}
{version_id}
{manifest_upload_auto_enabled_bit}
tus-write
{normalized_s3_path}
```

Every integer uses canonical base-10 ASCII without leading zeroes. The payload
ends after `normalized_s3_path`; it has no trailing newline.

Protocol version 1 does not sign `file_hash`, `uploaded_bytes_sha256`, or
`uploaded_bytes_size`. Signing them without validating the uploaded body would
not prove content integrity. A future protocol can bind and enforce those
fields explicitly.

### 8.3 Lifetime and expiration

Every issued token has a lifetime of no more than 10 minutes. The backend may
choose a shorter lifetime and returns the effective `expires_at` inside the
resolved upload target's `authorization` object. The CLI must not hard-code the
lifetime or derive it by parsing the opaque token.

The expiration is checked on every capability-bearing TUS `POST`, `HEAD`, and
`PATCH`. Protocol version 1 does not refresh an expired capability and does not
resume the same manifest upload with replacement tokens. The files endpoint
returns one of the explicit abandon fields described in Section 12 only after
it has verified the signature and can therefore trust the signed
`manifest_upload_auto_enabled` bit.

- Signed bit `0`: return `abandon_explicit_error` and abandon the entire bundle
  upload attempt.
- Signed bit `1`: return `abandon_manifest_only_explicit_error`, abandon only
  manifest upload, and permit the CLI to finish through the already-enabled
  full-ZIP path.

The CLI treats `authorization.expires_at` as server-provided metadata. It does
not use it to refresh, extend, or locally reinterpret the capability.

### 8.4 What the capability proves

A valid capability proves only:

> The backend authorized this version to write this exact normalized R2 path
> until the stated expiration.

It prevents changing the organization, app, prefix, filename hash, or logical
path after authorization. It does not prove that the bytes match any hash in
the manifest. Enforcing physical-byte integrity later requires the upload
handler to calculate or provider-verify `uploaded_bytes_sha256` and compare the
final size.

## 9. Changes to `/files/upload/attachments`

The existing TUS routes gain an alternative authorization branch for
`POST`, `HEAD`, and `PATCH`:

1. Normalize the R2 key using the same path rules used today.
   - For TUS creation, obtain it from normalized `Upload-Metadata.filename`.
   - For TUS `HEAD` and `PATCH`, obtain it from the normalized route/upload ID.
2. If `X-Capgo-Upload-Token` is present, parse and validate the capability.
3. Reconstruct the canonical payload using the normalized request path.
4. Verify the HMAC, supported key ID, scope, protocol version, and expiration.
5. If valid, skip the per-request API-key identity, RBAC, app ownership, hosted
   plan eligibility, and finalized-full-bundle immutability queries that were
   already bounded at capability issuance or made impossible by the issued
   delta path.
6. Forward the request to the existing TUS implementation and return its
   existing completion receipt unchanged.

If the capability header is present but invalid, the request is rejected. The
handler must not fall back to an accompanying API key because that would create
an authentication downgrade and hide client bugs.

If the capability header is absent, the existing API-key middleware and
database authorization path run unchanged. Published CLIs therefore continue
to work.

The current upload code's `readyBundlePath` query is specifically an
immutability guard for a version-specific full bundle: it rejects writing a key
equal to a live `app_versions.r2_path` after that version is no longer
`r2-direct`. It is not a manifest-file readiness check. The new endpoint issues
capabilities only for derived delta paths belonging to an uploadable
`r2-direct` version, so the capability branch does not repeat that query. The
legacy API-key branch retains it unchanged.

The capability header must be added to the upload CORS allowlist. The CLI sends
it on every TUS request generated by `tus-js-client`.

These changes are limited to `/files/upload/attachments` TUS authorization.
iOS and Android updater devices download through `/files/read/attachments` and
do not perform these TUS `POST`, `HEAD`, or `PATCH` requests. Tests must prove
that plugin update responses and normal native file downloads remain unchanged.

## 10. End-to-end CLI flow

```text
1. Build files locally.
2. Compute the complete logical manifest.
3. Apply per-file Brotli compression where selected.
4. Apply delta encryption where enabled.
5. Compute file_hash, uploaded_bytes_sha256, and uploaded_bytes_size.
6. Create the app_versions row with storage_provider = r2-direct.
7. Determine manifest_upload_auto_enabled from the user's CLI options and ZIP
   fallback availability.
8. POST the complete manifest to /private/request_manifest_upload.
9. Merge response entries by id and construct each exact s3_path.
10. Execute every entry according to its resolved action:
   a. upload_if_doesnt_exist: probe, reuse on success, or upload on 404;
   b. reuse: skip probe and upload, and consume the server-provided receipt;
   c. upload: skip the probe and upload immediately.
11. Collect one manifest-size receipt for every entry.
12. POST the final manifest to /private/set_manifest with file_name, file_hash,
    server-selected s3_path, and a receipt for every entry.
13. Finalize the version through the existing compatible flow.
```

The CLI must continue the current all-or-none receipt rule. If any entry lacks
a valid receipt, it must not silently submit a mixed receipt manifest.
`abandon_manifest_only_explicit_error` is the deliberate exception to the
normal manifest path: the CLI skips `set_manifest` and finishes the version
through ZIP-only finalization. `abandon_explicit_error` stops the entire attempt.

## 11. Final manifest construction

For each request entry and response entry with the same `id`, the CLI constructs
the existing `set_manifest` entry:

```json
{
  "file_name": "<request file_name>",
  "file_hash": "<request file_hash>",
  "s3_path": "<resolved complete response path>",
  "file_size_receipt": "<receipt from existence probe or completed TUS upload>"
}
```

`uploaded_bytes_sha256`, `uploaded_bytes_size`, `compression`,
`file_hash_format`, and `delta_encryption` are not persisted by
`set_manifest` in protocol version 1. They are carried now so the protocol can
later enforce physical-byte integrity or make reuse decisions without another
breaking request redesign.

## 12. Error behavior

Errors use the repository's existing flat JSON convention:

```json
{
  "error": "error_manifest_upload_request_invalid",
  "message": "Manifest upload request is invalid",
  "moreInfo": {
    "field": "entries[14].uploaded_bytes_sha256"
  }
}
```

Recommended status and code mapping:

| HTTP status | Error code | Condition |
| --- | --- | --- |
| `400` | `error_manifest_upload_request_invalid` | Malformed JSON, unsupported protocol, invalid top-level value, duplicate ID, or invalid field encoding. |
| `401` | `not_authorized` | Missing or invalid API-key authentication. |
| `404` | `error_version_not_found` | Version does not exist or is inaccessible to the caller. |
| `409` | `error_version_not_uploadable` | Version is deleted, finalized, or not in `r2-direct`. |
| `409` | `error_delta_encryption_invalid` | Delta encryption is requested without a stored session key, or hash format and encryption mode disagree. |
| `413` | `error_manifest_too_large` | More than 10,000 entries or transport/body limits exceeded. |
| `422` | `error_manifest_entry_invalid` | A specific entry is structurally valid JSON but has an invalid name, size, hash, or duplicate resulting path. |
| `429` | existing on-premise/plan code | Existing hosted-upload eligibility rejection; preserve its response body and cache headers. |
| `503` | `upload_authorization_unavailable` | Signing configuration is unavailable; no unsigned fallback. |

For capability-bearing upload requests:

| HTTP status | Error code | Condition |
| --- | --- | --- |
| `401` | `upload_token_invalid` | Malformed token, unknown key ID, invalid signature, wrong scope, or wrong protocol. |
| `401` | `upload_token_expired` | Token is correctly signed but expired. The response also contains the applicable explicit abandon field; the CLI does not refresh or resume manifest upload. |
| `403` | `upload_path_not_authorized` | The normalized request path differs from the signed path. |

Errors must identify an entry by request-local `id` or array index but must not
echo secrets, complete tokens, session keys, or large submitted values.

### 12.1 Explicit upload rejection

The files endpoint may mark a response as a non-retryable rejection of the
entire upload attempt by including `abandon_explicit_error`:

```json
{
  "error": "upload_capability_rejected",
  "message": "Upload authorization was rejected",
  "abandon_explicit_error": "Upload authorization could not be verified. Please contact Capgo support.",
  "moreInfo": {
    "requestId": "request-id"
  }
}
```

`abandon_explicit_error` is independent of the HTTP status so the same CLI
behavior can later be used for a `422` physical-byte hash or size mismatch. The
backend controls the complete message. The protocol and CLI do not impose an
arbitrary character limit on it. The backend must still never include secrets
or submitted file contents.

The initial capability verifier returns this field for non-recoverable
capability failures such as malformed tokens, unsupported token versions,
invalid signatures, or a signed-path mismatch. The message tells the user to
contact Capgo support and includes the normal request ID separately.

An expired, otherwise valid token is not refreshed in protocol version 1. When
the verified signed `manifest_upload_auto_enabled` bit is `0`, the files
endpoint returns:

```json
{
  "error": "upload_token_expired",
  "message": "Upload authorization expired",
  "abandon_explicit_error": "Your upload has expired. Uploading files took too long. Please re-run the command"
}
```

When the verified signed bit is `1`, the files endpoint instead returns:

```json
{
  "error": "upload_token_expired",
  "message": "Upload authorization expired",
  "abandon_manifest_only_explicit_error": "Your manifest upload has expired. Uploading manifest files took too long. Continuing with ZIP-only upload."
}
```

The files endpoint may trust the bit only after successfully verifying the HMAC.
A malformed token, unknown key, invalid HMAC, unsupported token version, or
signed-path mismatch cannot safely select the manifest-only fallback and must
use `abandon_explicit_error` with a message directing the user to contact Capgo
support.

When the CLI sees a valid JSON string `abandon_explicit_error` in a TUS error
response, it must:

1. stop scheduling new existence checks and uploads;
2. abort every active sibling TUS upload in the current manifest batch;
3. treat the error as fatal even when delta upload was auto-enabled;
4. skip the generic upload retry prompt;
5. invoke the existing failed-version cleanup path;
6. exit nonzero after printing:

```text
Abandoning manifest upload. The following error occurred: {message}
Please contact Capgo support if the issue persists. Request ID: {requestId}
```

When the CLI sees a valid JSON string
`abandon_manifest_only_explicit_error`, it must:

1. stop scheduling new manifest existence checks and TUS uploads;
2. abort every active manifest TUS upload in the current batch;
3. skip `set_manifest` and discard the incomplete manifest from this attempt;
4. continue or finish the full-ZIP upload;
5. finalize the version through the existing ZIP-only flow once the ZIP upload
   succeeds;
6. not invoke failed-version cleanup merely because manifest upload was
   abandoned; and
7. print the complete backend-provided message as a clear warning.

This field is valid only when ZIP upload was enabled as a fallback, which is
why the CLI may report `manifest_upload_auto_enabled: true` only in that case.
If the CLI receives this field without a usable ZIP fallback, it must treat the
response as a full `abandon_explicit_error` rather than finalize an incomplete
version.

The CLI must parse the body from `tus.DetailedError.originalResponse` rather
than relying only on a regular expression over `error.toString()`. It should
strip terminal control characters from the displayed value, but it must not
truncate the backend-provided error because of a client-side protocol limit.

The current CLI already propagates TUS failures and the outer upload flow
attempts `delete_failed_version`, but `Promise.all` rejection does not cancel
other active TUS clients and there is no generic explicit-abandon body contract.
Both behaviors are therefore required new CLI work, not assumptions about the
current implementation.

### 12.2 Failed attempts and object reuse

Before `set_manifest` succeeds, the database has no manifest rows naming the
delta objects that completed during the failed attempt. The existing
failed-version cleanup therefore cannot discover those objects and does not
delete them from R2.

The consequences depend on the path type:

- Completed unencrypted delta objects use deterministic paths shared across
  versions. A later CLI run derives the same paths, finds the objects through
  `upload_if_doesnt_exist`, obtains fresh size receipts, and reuses them instead
  of uploading them again.
- Completed encrypted delta objects use the version's random session-key path
  component. A newly created retry version normally has a new session key and
  different paths, so it cannot reuse the earlier encrypted objects. Those
  unreferenced objects require a separate future lifecycle/garbage-collection
  solution; this endpoint does not add one.
- An incomplete TUS upload is not a completed reusable R2 object. Aborting
  active sibling uploads remains important even though completed objects can
  remain.

On `abandon_explicit_error`, the CLI invokes the existing failed-version
cleanup path. Today that path can hard-delete an `r2-direct` version row only
when its full-ZIP `r2_path` object is absent; it refuses the hard delete after
the ZIP object exists. The design must not claim that the version row is always
removed until that existing limitation is deliberately resolved.

On `abandon_manifest_only_explicit_error`, the CLI deliberately does not clean
up the version. It finishes and finalizes the ZIP-only version, while any
completed but unreferenced manifest objects remain subject to the reuse and
orphan rules above.

## 13. Payload and runtime limits

The endpoint treats a 5,000-file bundle as an expected production case, not an
edge case, and enforces the existing hard maximum of 10,000 entries. "Bounded"
means that count and field lengths have explicit ceilings and that CPU, memory,
database work, and response size grow linearly up to those ceilings; it does not
mean a 10,000-entry JSON document is small.

To keep it bounded:

- authorize and load the version/app once, never once per entry;
- make no R2 request;
- make no per-entry database query or write;
- return request-local IDs instead of echoing manifest fields;
- return the common R2 prefix once;
- return upload-target and authorization transport metadata once;
- return only the resolved path data and one opaque token per uploadable entry;
- support normal HTTP response compression;
- validate lengths before expensive hashing;
- hash and sign with bounded concurrency rather than launching 10,000
  concurrent WebCrypto promises;
- cap decoded body bytes in addition to entry count;
- log only entry count, encoded request/response size, elapsed time, and failure
  category, never the complete manifest.

The implementation must benchmark 10,000-entry unencrypted and encrypted
requests in the actual Worker runtime. The test should measure JSON parse
memory, path derivation time, 10,000 HMAC operations, compressed and
uncompressed response size, and total CPU/wall time. Guessing that 10,000
signatures fit the runtime is not sufficient.

## 14. Security properties and accepted limitations

### Properties

- A caller cannot select another organization's or application's prefix.
- A token for one R2 path cannot authorize another path.
- The upload hot path needs no database or Supabase Auth call when the token is
  present and valid.
- Expiration limits replay duration.
- Key IDs allow rotation without interrupting active uploads.
- Existing API-key uploads remain compatible.

### Accepted protocol-version-1 limitations

- A valid token can be replayed against the same path until expiration.
- Plan or permission revocation after token issuance takes effect only when the
  token expires.
- The backend accepts but does not enforce the submitted byte digest or size.
  An authorized caller can therefore upload incorrect bytes to an authorized
  path, as an API-key-authorized caller can today.
- The endpoint does not know whether an R2 object exists.
- Deterministic reusable paths retain the lifecycle race described in the R2
  object-lifecycle proposal; this protocol must not be treated as permission to
  enable unsafe per-object deletion.

## 15. Compatibility and rollout

1. Add and test capability verification to the upload handler while keeping the
   legacy API-key branch unchanged.
2. Add `request_manifest_upload` behind the boolean `manifestUpload` capability
   returned by `/files/config`. New CLIs use this protocol only when that field
   is exactly `true`; a missing or false field keeps the existing client-derived
   path and API-key upload flow.
3. Shadow-generate server paths in tests and prove byte-for-byte equality with
   the current CLI for:
   - unencrypted SHA-256 entries;
   - Brotli and non-Brotli filenames;
   - legacy RSA base64 hashes;
   - RSA v3 hexadecimal hashes;
   - encrypted session-key prefixes;
   - Unicode and percent-containing safe path segments.
4. Load-test the full 10,000-entry request and response.
5. Add parity tests proving the new endpoint reuses the same API-key, RBAC,
   owner-org, hosted-plan, and on-premise decisions as the existing attachment
   upload path.
6. Add upload routing tests proving:
   - a request without the capability header follows the unchanged legacy
     API-key path;
   - a valid capability reaches TUS without a database authorization lookup;
   - an invalid capability never falls back to the API key;
   - normal iOS/Android `/files/read/attachments` requests and plugin update
     responses are unchanged.
7. Add receipt tests for successful attachment `GET`, implicit `HEAD`, and
   cache-hit responses with and without `x-cli-version` and `nocache`.
8. Add CLI contract tests for all three actions, complete and prefixed paths,
   target overrides, arbitrary opaque prefix/suffix lengths, expiry without
   refresh, full-abandon cleanup behavior, and manifest-only ZIP fallback.
9. Release a CLI that opts into the endpoint only when the backend advertises
   support.
10. Retain the existing direct path derivation and API-key upload flow for
   already-published CLI versions.
11. Observe endpoint latency, token failures, expiration frequency, request and
   response sizes, TUS completion rate, ZIP fallback rate, and receipt
   completeness before making it the default for a newly published CLI.

The endpoint is stateless and safely retryable: the same version and identical
manifest produce the same R2 paths and a fresh expiring authorization context.
Changing a manifest entry can change its path and token, so the CLI must discard
the earlier response rather than combine responses from different request
bodies.

## 16. Fixed protocol-version-1 decisions

- Endpoint: `POST /private/request_manifest_upload`.
- One complete manifest request, maximum 10,000 entries.
- Strict request schema; client-supplied ownership, storage-path, and session-key
  fields are rejected.
- Existing `middlewareKey`, auth context, RBAC, app lookup, and attachment plan
  eligibility helpers are reused rather than reimplemented.
- Server controls `owner_org`, `app_id`, `session_key`, R2 path, upload URL, and
  authorization expiration.
- CLI sends both `file_hash` and `uploaded_bytes_sha256` for every entry.
- CLI sends explicit delta-file encryption and hash-format metadata.
- Initial backend responses preserve the existing deterministic R2 path layout.
- Responses support either an optional default prefix plus per-entry suffixes or
  complete per-entry paths, including mixed use in one response.
- Upload target and authorization transport are one structure, selected through
  `default_upload_target` with optional per-entry overrides.
- Backend performs no R2 existence checks.
- Default and only emitted action: `upload_if_doesnt_exist`.
- The adopting CLI implements `upload_if_doesnt_exist`, `reuse`, and `upload`
  before the endpoint is enabled.
- Upload authorization: exact-path compact HMAC-SHA-256 capability.
- The target-scoped authorization object owns the shared token prefix; each
  uploadable entry carries only its opaque token suffix. The CLI concatenates
  them without validating either representation or length.
- Upload-capability HMAC uses a dedicated secret distinct from the existing
  manifest-size receipt secret.
- `manifest_upload_auto_enabled` is required and its `1` or `0` value is signed
  into every capability.
- Token lifetime is at most 10 minutes. Protocol version 1 does not refresh or
  resume an expired manifest upload.
- Capability-bearing uploads skip database authorization; invalid capabilities
  never fall back to API-key authentication.
- Successful attachment `GET` and `HEAD` responses include the existing size
  receipt whenever `nocache` or nonempty `x-cli-version` is present.
- Invalid capability authentication and future content-integrity failures may
  return `abandon_explicit_error`; the CLI aborts sibling uploads, attempts
  failed-version cleanup, displays the complete backend message, and does not
  prompt for retry.
- An expired valid capability returns `abandon_manifest_only_explicit_error`
  only when the verified signed auto-enabled bit is `1`; the CLI abandons the
  manifest but may complete the version through the ZIP-only path. Otherwise
  expiration returns `abandon_explicit_error` with the specified rerun message.
- Existing TUS upload receipts and `set_manifest` remain the completion path.
- No reservation, lifecycle-table write, or garbage-collection behavior is
  introduced by this endpoint.
