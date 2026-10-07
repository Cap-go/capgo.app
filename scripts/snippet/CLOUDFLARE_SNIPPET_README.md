# Cloudflare Snippet - App ID Filter

This Cloudflare Snippet filters requests to Capgo plugin endpoints based on the `app_id` field in the request body or query parameters.

## Filtered Endpoints

The snippet filters the following endpoints:

- **`/updates`** (POST) - Update check endpoint
- **`/stats`** (POST) - Statistics reporting endpoint
- **`/channel_self`** (POST, PUT, DELETE, GET) - Channel management endpoint

## Files

1. **cloudflare-snippet-filter-appid.js** - Static blocklist/allowlist implementation

## How It Works

The snippets intercept requests to the plugin endpoints and:

1. Parse the JSON request body
2. Extract the `app_id` field
3. Check if the `app_id` is in the blocked/allowed list
4. Either forward the request or return a 403 Forbidden response

### Request Body Structure

All three endpoints include `app_id` in their JSON request body:

**`/updates` endpoint:**
```json
{
  "app_id": "com.example.app",
  "device_id": "uuid-device-id",
  "version_name": "1.0.0",
  "version_build": "100",
  "is_emulator": false,
  "is_prod": true,
  "platform": "ios",
  "plugin_version": "6.0.0",
  "defaultChannel": "production"
}
```

**`/stats` endpoint:**
```json
{
  "app_id": "com.example.app",
  "device_id": "uuid-device-id",
  "platform": "ios",
  "version_name": "1.0.0",
  "version_os": "17.0",
  "action": "set",
  "is_emulator": false,
  "is_prod": true
}
```

**`/channel_self` endpoint:**
```json
{
  "app_id": "com.example.app",
  "device_id": "uuid-device-id",
  "version_name": "1.0.0",
  "version_build": "100",
  "platform": "ios",
  "channel": "production",
  "is_emulator": false,
  "is_prod": true
}
```

The snippet filters based on the `app_id` field present in all requests.

**Important:**
- POST and PUT methods send `app_id` in the request body
- GET and DELETE methods on `/channel_self` send `app_id` as a query parameter
- The snippet handles both cases automatically

## Deployment

### Step 1: Update the Configuration

Edit [cloudflare-snippet-filter-appid.js](cloudflare-snippet-filter-appid.js) and update the app ID list:

```javascript
// For blocklist approach (block specific apps)
const BLOCKED_APP_IDS = [
  'com.example.notcapgo',
  'com.another.blocked',
];

// OR for allowlist approach (only allow specific apps)
const ALLOWED_APP_IDS = [
  'ee.forgr.capacitor_go',
  'com.example.capgoapp',
];
```

Choose either blocklist or allowlist by commenting/uncommenting the appropriate code section.

### Step 2: Deploy to Cloudflare

1. Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your zone/domain
3. Navigate to **Rules** → **Snippets**
4. Click **Create Snippet**
5. Name it: `app-id-filter`
6. Paste the code from `cloudflare-snippet-filter-appid.js`
7. Click **Deploy**

### Step 3: Create a Rule to Execute the Snippet

1. Navigate to **Rules** → **Transform Rules** → **Modify Request**
2. Click **Create rule**
3. Name it: `Execute App ID Filter`
4. Under **When incoming requests match**, set:
   - Field: `URI Path`
   - Operator: `is in`
   - Values: `/updates`, `/stats`, `/channel_self`
5. Under **Then**, select **Execute Snippet** and choose `app-id-filter`
6. Click **Deploy**

## Updating the Filter List

To update the blocked or allowed app IDs, simply:

1. Edit the `cloudflare-snippet-filter-appid.js` file
2. Update the `BLOCKED_APP_IDS` or `ALLOWED_APP_IDS` array
3. Re-deploy the snippet in Cloudflare Dashboard (copy-paste the updated code)

**Note:** Cloudflare Snippets do not support KV storage for dynamic configuration. If you need dynamic updates without redeploying, consider using a Cloudflare Worker instead.

## Configuration Options

### Blocklist Mode
- **Use case**: Block specific apps that should NOT use Capgo
- **Logic**: Requests are blocked if `app_id` is in the blocklist
- **Default action**: Allow all apps except those in the list

### Allowlist Mode
- **Use case**: Only allow specific apps that ARE using Capgo
- **Logic**: Requests are blocked if `app_id` is NOT in the allowlist
- **Default action**: Block all apps except those in the list

## Testing

Test the filter with curl on all three endpoints:

### Test /updates endpoint:

```bash
# Should be blocked (if com.blocked.app is in blocklist)
curl -X POST https://yourdomain.com/updates \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "com.blocked.app",
    "device_id": "test-device-123",
    "version_name": "1.0.0",
    "version_build": "100",
    "is_emulator": false,
    "is_prod": true,
    "platform": "ios",
    "plugin_version": "6.0.0"
  }'

# Should be allowed (if ee.forgr.capacitor_go is not in blocklist)
curl -X POST https://yourdomain.com/updates \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "ee.forgr.capacitor_go",
    "device_id": "test-device-123",
    "version_name": "1.0.0",
    "version_build": "100",
    "is_emulator": false,
    "is_prod": true,
    "platform": "ios",
    "plugin_version": "6.0.0"
  }'
```

### Test /stats endpoint:

```bash
# Should be blocked (if com.blocked.app is in blocklist)
curl -X POST https://yourdomain.com/stats \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "com.blocked.app",
    "device_id": "test-device-123",
    "platform": "ios",
    "version_name": "1.0.0",
    "version_os": "17.0",
    "action": "set",
    "is_emulator": false,
    "is_prod": true
  }'
```

### Test /channel_self endpoint:

```bash
# Should be blocked (if com.blocked.app is in blocklist)
curl -X POST https://yourdomain.com/channel_self \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "com.blocked.app",
    "device_id": "test-device-123",
    "version_name": "1.0.0",
    "version_build": "100",
    "platform": "ios",
    "channel": "production",
    "is_emulator": false,
    "is_prod": true
  }'

# Test PUT method
curl -X PUT https://yourdomain.com/channel_self \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "com.blocked.app",
    "device_id": "test-device-123",
    "version_name": "1.0.0",
    "version_build": "100",
    "platform": "ios",
    "is_emulator": false,
    "is_prod": true
  }'

# Test DELETE method (uses query params)
curl -X DELETE "https://yourdomain.com/channel_self?app_id=com.blocked.app&device_id=test-device-123&version_build=100"

# Test GET method (uses query params)
curl -X GET "https://yourdomain.com/channel_self?app_id=com.blocked.app&device_id=test-device-123&version_name=1.0.0&version_build=100&platform=ios&is_emulator=false&is_prod=true"
```

## Performance Considerations

1. **Minimal Overhead**: Very fast array lookup, ~0-1ms added latency
2. **Edge Execution**: Runs at Cloudflare's edge, before reaching your backend
3. **Body Parsing**: Request is cloned before parsing to avoid consuming the stream
4. **Error Handling**: If body/query parsing fails, the request is forwarded to the backend

## Best Practices

1. **Start with Blocklist**: Easier to manage and less risky than allowlist
2. **Monitor via Analytics**: Use Cloudflare Analytics to see blocked requests
3. **Gradual Rollout**: Start with a few apps, monitor, then expand
4. **Keep Lists Updated**: Regularly review and update your filter lists
5. **Test Before Production**: Always test with curl before deploying to production

## Security Notes

- The filter runs at the edge, before requests reach your backend
- Blocked requests never consume backend resources
- Invalid JSON or missing `app_id` results in a 400 Bad Request
- Unauthorized apps receive a 403 Forbidden response
- All filtering happens server-side and cannot be bypassed by clients

## Troubleshooting

### Snippet not filtering requests
- Check that the rule is deployed and active
- Verify the URI path matching pattern includes all three endpoints: `/updates`, `/stats`, `/channel_self`
- Ensure the rule matches the correct HTTP methods (POST for updates/stats, POST/PUT/DELETE/GET for channel_self)
- Check Cloudflare Logs for snippet execution errors

### All requests being blocked
- Check the filter mode (blocklist vs allowlist)
- Verify the list configuration
- Check for typos in app_id values

## Support

For issues or questions:
- Check [Cloudflare Snippets Documentation](https://developers.cloudflare.com/rules/snippets/)
- Review [Cloudflare Workers KV Documentation](https://developers.cloudflare.com/kv/)
- Open an issue in this repository

## Minified build (32 KB limit)

Cloudflare Snippets are limited to 32 KB. Deploy `cloudflare_workers/snippet/index.min.js`, not `index.js`.

- `bun run build:snippet` regenerates `index.min.js` (header carries app version + source hash).
- `bun run check:snippet` fails if `index.min.js` is stale or over 32 KB (enforced by `tests/cloudflare-snippet-build.unit.test.ts`).
