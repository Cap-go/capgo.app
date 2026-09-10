import { _Object, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectsV2CommandOutput, S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { writeFileSync, existsSync, readFileSync } from 'fs'
import { S3Client as S3ClientLite } from '@bradenmacdonald/s3-lite-client/'
import { Pool } from 'pg'
import { Context } from 'vm'
import { applyR2ConditionalDeleteMiddleware, createAwsTrashDestinationResolver, encodeS3CopySource, ConcurrencyLimiter, isAlreadyMovedToTrash, isLiveR2Key, isObjectNotFoundError, isPreconditionFailedError, resolveOpsDeleteMode, resolveTrashDestinationKey } from './r2_trash_utils.ts'

const S3_BUCKET = 'capgo'
const CHECKPOINT_FILE = './objects_checkpoint.json'
const OUTPUT_FILE = './objects.json'
const BATCH_SIZE = 1000 // Write to disk every N objects

interface Checkpoint {
    continuationToken: string | null
    objectCount: number
    lastUpdate: string
}


async function main() {
    const args = process.argv.slice(2)
    const command = args[0]

    if (!command) {
        console.error('❌ No command specified')
        console.error('Usage: ts-node check_r2_big_files.ts <command>')
        console.error('Commands:')
        console.error('  fetch_objects - Fetch all objects from R2')
        console.error('  json_big_files - Process big files from JSON')
        console.error('  folder_size <folder_path> - Calculate total size of a folder')
        console.error('  total_size - Calculate total size of all objects')
        console.error('  object_size <object_path> - Get size of a specific object')
        console.error('  export_files_folder_to_csv <folder_path> - Export all files in a folder to CSV')
        console.error('  get_app_versions - Export all app_versions from database to JSON')
        console.error('  get_big_orgs - Analyze organization storage usage from app versions and objects data')
        console.error('  export_supabase_csv <org_id> - Export bundle information for an organization to CSV')
        console.error('  prepare_cleanup_zip - Find orphaned zip files in R2 with no database records')
        console.error('  copy_cleanup_candidates_to_backup_bucket - Copy cleanup candidates to backup bucket')
        console.error('  copy_cleanup_candidates_direct - Copy cleanup candidates using direct S3 copy (faster but may not work on R2)')
        console.error('  delete_cleanup_candidates - Move orphaned files to 7-day trash (DRY_RUN=false; ALLOW_PERMANENT_R2_DELETE=true for permanent)')
        process.exit(1)
    }

    switch (command) {
        case 'fetch_objects':
            await fetch_objects()
            break
        case 'json_big_files':
            await json_big_files()
            break
        case 'folder_size':
            const folderPath = args[1]
            if (!folderPath) {
                console.error('❌ No folder path specified')
                console.error('Usage: ts-node check_r2_big_files.ts folder_size <folder_path>')
                process.exit(1)
            }
            await folder_size(folderPath)
            break
        case 'total_size':
            await total_size()
            break
        case 'object_size':
            const objectPath = args[1]
            if (!objectPath) {
                console.error('❌ No object path specified')
                console.error('Usage: ts-node check_r2_big_files.ts object_size <object_path>')
                console.error('Example: ts-node check_r2_big_files.ts object_size orgs/74eea063-512c-4763-beae-1d4ba1c303c5/apps/com.math99.mobile/3.0.384+b.114134.master.1c98e3dfe.zip')
                process.exit(1)
            }
            await object_size(objectPath)
            break
        case 'export_files_folder_to_csv':
            const csvFolderPath = args[1]
            if (!csvFolderPath) {
                console.error('❌ No folder path specified')
                console.error('Usage: ts-node check_r2_big_files.ts export_files_folder_to_csv <folder_path>')
                console.error('Example: ts-node check_r2_big_files.ts export_files_folder_to_csv orgs/my-org/apps/')
                process.exit(1)
            }
            await export_files_folder_to_csv(csvFolderPath)
            break
        case 'get_app_versions':
            await get_app_versions()
            break
        case 'get_big_orgs':
            await get_big_orgs()
            break
        case 'export_supabase_csv':
            const orgId = args[1]
            if (!orgId) {
                console.error('❌ No organization ID specified')
                console.error('Usage: ts-node check_r2_big_files.ts export_supabase_csv <org_id>')
                process.exit(1)
            }
            await export_supabase_csv(orgId)
            break
        case 'prepare_cleanup_zip':
            await prepare_cleanup_zip()
            break
        case 'copy_cleanup_candidates_to_backup_bucket':
            await copy_cleanup_candidates_to_backup_bucket()
            break
        case 'copy_cleanup_candidates_direct':
            await copy_cleanup_candidates_direct()
            break
        case 'delete_cleanup_candidates':
            await delete_cleanup_candidates()
            break
        default:
            console.error(`❌ Unknown command: ${command}`)
            console.error('Available commands: fetch_objects, json_big_files, folder_size, total_size, object_size, export_files_folder_to_csv, get_app_versions, get_big_orgs, export_supabase_csv, prepare_cleanup_zip, copy_cleanup_candidates_to_backup_bucket, copy_cleanup_candidates_direct, delete_cleanup_candidates')
            process.exit(1)
    }
}

async function fetch_objects() {
    const s3 = await initS3()

    // Check if we have a previous checkpoint
    let checkpoint: Checkpoint | null = null
    let existingObjects: _Object[] = []

    if (existsSync(CHECKPOINT_FILE)) {
        console.log('🔄 Found checkpoint file, resuming from last position...')
        checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))

        // Load existing objects if output file exists
        if (existsSync(OUTPUT_FILE)) {
            existingObjects = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'))
            console.log(`📋 Loaded ${existingObjects.length} existing objects`)
        }
    }

    const objects = await listAllObjectsInFolder(s3, 'orgs/', checkpoint, existingObjects)

    // Final save
    writeFileSync(OUTPUT_FILE, JSON.stringify(objects, null, 2))

    // Clean up checkpoint file on successful completion
    if (existsSync(CHECKPOINT_FILE)) {
        const fs = await import('fs/promises')
        await fs.unlink(CHECKPOINT_FILE)
        console.log('✅ Completed! Checkpoint file removed.')
    }

    console.log(`\n🎉 Done! Total objects: ${objects.length}`)
    // const bigFiles = objects.filter(obj => (obj.Size ?? 0) > 100 * 1024 * 1024) // 100MB
}

async function json_big_files() {
    if (!existsSync(OUTPUT_FILE)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading objects from JSON...')
    const objects: _Object[] = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'))
    console.log(`📊 Total objects loaded: ${objects.length}`)

    // Sort by size (descending) and take top 50
    const topFiles = objects
        .filter(obj => obj.Size !== undefined && obj.Size > 0)
        .sort((a, b) => (b.Size ?? 0) - (a.Size ?? 0))
        .slice(0, 50)

    console.log('\n🏆 Top 50 Biggest Files:')
    console.log('========================')

    topFiles.forEach((file, index) => {
        const sizeMB = ((file.Size ?? 0) / (1024 * 1024)).toFixed(2)
        console.log(`${(index + 1).toString().padStart(2, '0')}. ${file.Key} - ${sizeMB} MB`)
    })

    // Calculate total size of top 50
    const totalSize = topFiles.reduce((sum, file) => sum + (file.Size ?? 0), 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)
    console.log('\n📈 Summary:')
    console.log(`Total size of top 50 files: ${totalSizeGB} GB`)

    // Save to separate file
    const outputPath = './top_50_biggest_files.json'
    writeFileSync(outputPath, JSON.stringify(topFiles, null, 2))
    console.log(`\n✅ Saved top 50 biggest files to: ${outputPath}`)
}

async function folder_size(folderPath: string) {
    if (!existsSync(OUTPUT_FILE)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading objects from JSON...')
    const objects: _Object[] = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'))
    console.log(`📊 Total objects loaded: ${objects.length}`)

    // Ensure folder path ends with /
    const normalizedPath = folderPath.endsWith('/') ? folderPath : folderPath + '/'

    // Filter objects in the specified folder
    const folderObjects = objects.filter(obj =>
        obj.Key && obj.Key.startsWith(normalizedPath)
    )

    if (folderObjects.length === 0) {
        console.log(`❌ No files found in folder: ${normalizedPath}`)
        return
    }

    // Calculate total size
    const totalSize = folderObjects.reduce((sum, obj) => sum + (obj.Size ?? 0), 0)

    // Calculate size in different units
    const sizeKB = totalSize / 1024
    const sizeMB = sizeKB / 1024
    const sizeGB = sizeMB / 1024
    const sizeTB = sizeGB / 1024

    console.log(`\n📁 Folder: ${normalizedPath}`)
    console.log('========================')
    console.log(`📊 Total files: ${folderObjects.length}`)
    console.log(`💾 Total size:`)
    console.log(`   - ${totalSize.toLocaleString()} bytes`)
    console.log(`   - ${sizeKB.toFixed(2)} KB`)
    console.log(`   - ${sizeMB.toFixed(2)} MB`)
    console.log(`   - ${sizeGB.toFixed(2)} GB`)
    if (sizeTB >= 0.01) {
        console.log(`   - ${sizeTB.toFixed(2)} TB`)
    }

    // Find biggest files in this folder
    const topFiles = folderObjects
        .filter(obj => obj.Size && obj.Size > 0)
        .sort((a, b) => (b.Size ?? 0) - (a.Size ?? 0))
        .slice(0, 10)

    if (topFiles.length > 0) {
        console.log(`\n🏆 Top ${Math.min(10, topFiles.length)} biggest files in this folder:`)
        topFiles.forEach((file, index) => {
            const sizeMB = ((file.Size ?? 0) / (1024 * 1024)).toFixed(2)
            const relativePath = file.Key?.substring(normalizedPath.length) ?? ''
            console.log(`${(index + 1).toString().padStart(2, '0')}. ${relativePath} - ${sizeMB} MB`)
        })
    }
}

async function total_size() {
    if (!existsSync(OUTPUT_FILE)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading objects from JSON...')
    const objects: _Object[] = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'))
    console.log(`📊 Total objects loaded: ${objects.length}`)

    // Calculate total size
    const totalSize = objects.reduce((sum, obj) => sum + (obj.Size ?? 0), 0)

    // Calculate size in different units
    const sizeKB = totalSize / 1024
    const sizeMB = sizeKB / 1024
    const sizeGB = sizeMB / 1024
    const sizeTB = sizeGB / 1024
    const sizePB = sizeTB / 1024

    console.log('\n📊 Total Storage Summary')
    console.log('========================')
    console.log(`📁 Total objects: ${objects.length.toLocaleString()}`)
    console.log(`💾 Total size:`)
    console.log(`   - ${totalSize.toLocaleString()} bytes`)
    console.log(`   - ${sizeKB.toFixed(2)} KB`)
    console.log(`   - ${sizeMB.toFixed(2)} MB`)
    console.log(`   - ${sizeGB.toFixed(2)} GB`)
    console.log(`   - ${sizeTB.toFixed(2)} TB`)
    if (sizePB >= 0.01) {
        console.log(`   - ${sizePB.toFixed(2)} PB`)
    }

    // Calculate average file size
    const avgSize = totalSize / objects.length
    const avgSizeMB = avgSize / (1024 * 1024)
    console.log(`\n📈 Average file size: ${avgSizeMB.toFixed(2)} MB`)

    // Group by size ranges
    const sizeRanges = {
        '< 1MB': 0,
        '1MB - 10MB': 0,
        '10MB - 100MB': 0,
        '100MB - 1GB': 0,
        '> 1GB': 0
    }

    objects.forEach(obj => {
        const size = obj.Size ?? 0
        const sizeMB = size / (1024 * 1024)
        const sizeGB = sizeMB / 1024

        if (sizeMB < 1) sizeRanges['< 1MB']++
        else if (sizeMB < 10) sizeRanges['1MB - 10MB']++
        else if (sizeMB < 100) sizeRanges['10MB - 100MB']++
        else if (sizeGB < 1) sizeRanges['100MB - 1GB']++
        else sizeRanges['> 1GB']++
    })

    console.log('\n📊 File Size Distribution:')
    Object.entries(sizeRanges).forEach(([range, count]) => {
        const percentage = (count / objects.length * 100).toFixed(1)
        console.log(`   ${range}: ${count.toLocaleString()} files (${percentage}%)`)
    })
}

function convertToValidS3Path(path: string) {
    return path // path.replaceAll('+', '%2B')
}

async function object_size(objectPath: string) {
    console.log('🔄 Checking if object exists in R2...')
    const s3 = await initS3()

    try {
        // First check if object exists (similar to checkIfExist in s3.ts)
        let objectExists = false
        let headResponse

        try {

            const response = await s3.send(new HeadObjectCommand({
                Bucket: S3_BUCKET,
                Key: objectPath
            }))

            const s3Lite = await initS3Lite()

            const file = await s3Lite.statObject(convertToValidS3Path(objectPath))
            console.log({ message: 'object_size', file: JSON.stringify(file, null, 2) })


        } catch (error: any) {
            if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                objectExists = false
            } else {
                throw error // Re-throw if it's not a "not found" error
            }
        }

        if (!objectExists) {
            console.error(`❌ Object not exist in R2: ${objectPath}`)
            console.error('\n💡 Tips:')
            console.error('   - Make sure the path is exact (case-sensitive)')
            console.error('   - Check if the object exists in R2')
            console.error('   - Example: orgs/74eea063-512c-4763-beae-1d4ba1c303c5/apps/com.math99.mobile/3.0.384+b.114134.master.1c98e3dfe.zip')
            return
        }

        console.log('✅ Object exists, fetching details...')
        return

        // Calculate size in different units
        const size = headResponse!.ContentLength ?? 0
        const sizeKB = size / 1024
        const sizeMB = sizeKB / 1024
        const sizeGB = sizeMB / 1024

        console.log('\n📄 Object Details (Live from R2)')
        console.log('===================================')
        console.log(`🔑 Key: ${objectPath}`)
        console.log(`💾 Size:`)
        console.log(`   - ${size.toLocaleString()} bytes`)
        console.log(`   - ${sizeKB.toFixed(2)} KB`)
        console.log(`   - ${sizeMB.toFixed(2)} MB`)
        if (sizeGB >= 0.01) {
            console.log(`   - ${sizeGB.toFixed(2)} GB`)
        }

        if (headResponse!.LastModified) {
            console.log(`📅 Last Modified: ${headResponse!.LastModified.toISOString()}`)
        }

        if (headResponse!.ETag) {
            console.log(`🏷️  ETag: ${headResponse!.ETag}`)
        }

        if (headResponse!.ContentType) {
            console.log(`📝 Content Type: ${headResponse!.ContentType}`)
        }

        if (headResponse!.StorageClass) {
            console.log(`💼 Storage Class: ${headResponse!.StorageClass}`)
        }

        // Show file extension info
        const extension = objectPath.split('.').pop()
        if (extension) {
            console.log(`📝 File Extension: .${extension}`)
        }

        // Show folder path
        const folderPath = objectPath.substring(0, objectPath.lastIndexOf('/'))
        if (folderPath) {
            console.log(`📁 Folder: ${folderPath}/`)
        }
    } catch (error: any) {
        console.error('❌ Error checking object:', error.message)
        if (error.$metadata?.httpStatusCode) {
            console.error(`   HTTP Status: ${error.$metadata.httpStatusCode}`)
        }
    }
}

async function listAllObjectsInFolder(
    s3: S3Client,
    path: string,
    checkpoint: Checkpoint | null = null,
    existingObjects: _Object[] = []
) {
    const folderPrefix = path
    let continuationToken: string | null = checkpoint?.continuationToken || null
    let objects = [...existingObjects]
    let batchCount = 0
    const startTime = Date.now()

    try {
        while (true) {
            const data = await s3.send(new ListObjectsV2Command({
                Bucket: S3_BUCKET,
                Prefix: folderPrefix,
                ContinuationToken: continuationToken || undefined,
                MaxKeys: 1000 // Request max items per batch
            })) as ListObjectsV2CommandOutput

            const newObjects = data.Contents ?? []
            objects = objects.concat(newObjects)
            batchCount++

            // Progress update
            const elapsed = (Date.now() - startTime) / 1000
            const rate = objects.length / elapsed
            console.log(`📊 Progress: ${objects.length} objects | Batch #${batchCount} | ${newObjects.length} new | Rate: ${rate.toFixed(0)} obj/s`)

            // Save checkpoint and data every BATCH_SIZE objects
            if (objects.length % BATCH_SIZE === 0 || !data.IsTruncated) {
                // Save current progress
                writeFileSync(OUTPUT_FILE, JSON.stringify(objects, null, 2))

                // Save checkpoint (only if not finished)
                if (data.IsTruncated) {
                    const checkpoint: Checkpoint = {
                        continuationToken: data.NextContinuationToken ?? null,
                        objectCount: objects.length,
                        lastUpdate: new Date().toISOString()
                    }
                    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2))
                    console.log(`💾 Checkpoint saved at ${objects.length} objects`)
                }
            }

            continuationToken = data.NextContinuationToken ?? null

            if (!data.IsTruncated) {
                break
            }
        }
    }
    catch (err) {
        console.error('❌ Error listing objects:', err)
        console.error('💡 Progress has been saved. You can re-run the script to resume.')
        process.exit(1)
    }

    return objects
}

function getEnv(s: string) {
    return process.env[s] ?? ''
}

export function initS3() {
    const c = null
    const access_key_id = getEnv('S3_ACCESS_KEY_ID')
    const access_key_secret = getEnv('S3_SECRET_ACCESS_KEY')
    const storageEndpoint = getEnv('S3_ENDPOINT')
    const useSsl = getEnv('S3_SSL') !== 'false'

    const storageRegion = getEnv('S3_REGION')
    const params = {
        credentials: {
            accessKeyId: access_key_id,
            secretAccessKey: access_key_secret,
        },
        endpoint: `${useSsl ? 'https' : 'http'}://${storageEndpoint}`,
        region: storageRegion ?? 'us-east-1',
        // not apply in supabase local
        forcePathStyle: true, // storageEndpoint !== '127.0.0.1:54321/storage/v1/s3',
        signingEscapePath: false,
        // signingEscapePath: storageEndpoint !== '127.0.0.1:54321/storage/v1/s3',
    }

    console.log({
        message: 'initS3',
        params: {
            ...params,
            credentials: {
                accessKeyId: '[redacted]',
                secretAccessKey: '[redacted]',
            },
        },
    })

    return new S3Client({ ...params })
}

async function initS3Lite() {
    const access_key_id = getEnv('S3_ACCESS_KEY_ID')
    const access_key_secret = getEnv('S3_SECRET_ACCESS_KEY')
    const storageEndpoint = getEnv('S3_ENDPOINT')
    const storageRegion = getEnv('S3_REGION') || 'us-east-1'
    const useSSL = getEnv('S3_SSL') === 'true'
    const bucket = getEnv('S3_BUCKET')
    const endPoint = useSSL ? `https://${storageEndpoint}` : `http://${storageEndpoint}`
    const options = {
        endPoint,
        accessKey: access_key_id,
        pathStyle: true,
        secretKey: access_key_secret,
        region: storageRegion,
        bucket,
    }
    console.log({
        message: 'initS3Lite',
        options: {
            ...options,
            accessKey: '[redacted]',
            secretKey: '[redacted]',
        },
    })
    const client = new S3ClientLite(options)
    return client
}

async function export_files_folder_to_csv(folderPath: string) {
    if (!existsSync(OUTPUT_FILE)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading objects from JSON...')
    const objects: _Object[] = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'))
    console.log(`📊 Total objects loaded: ${objects.length}`)

    // Ensure folder path ends with /
    const normalizedPath = folderPath.endsWith('/') ? folderPath : folderPath + '/'

    // Filter objects in the specified folder
    const folderObjects = objects.filter(obj =>
        obj.Key && obj.Key.startsWith(normalizedPath) && obj.Key.endsWith('.zip')
    )

    if (folderObjects.length === 0) {
        console.log(`❌ No files found in folder: ${normalizedPath}`)
        return
    }

    console.log(`📁 Found ${folderObjects.length} files in folder: ${normalizedPath}`)

    // Create CSV content
    const csvHeaders = [
        'app_id',
        'version_name',
        'version_id',
        'size_bytes',
        'size_gb',
        'link'
    ]

    const csvRows = folderObjects.map(obj => {
        const size = obj.Size ?? 0
        const sizeGB = (size / (1024 * 1024 * 1024)).toFixed(6)
        const webLink = `https://console.capgo.app/app/${obj.Key?.split('/').pop() ?? ''}`

        return [
            `"${obj.Key?.split('/').pop() ?? ''}"`,
            `"${obj.Key?.split('/').slice(-2).pop() ?? ''}"`,
            obj.Key?.split('/').pop() ?? '',
            size.toString(),
            sizeGB,
            `"${webLink}"`
        ].join(',')
    })

    const csvContent = [csvHeaders.join(','), ...csvRows].join('\n')

    // Generate output filename
    const sanitizedPath = normalizedPath.replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    const outputPath = `./folder_export_${sanitizedPath}.csv`

    // Write CSV file
    writeFileSync(outputPath, csvContent)

    // Calculate some statistics
    const totalSize = folderObjects.reduce((sum, obj) => sum + (obj.Size ?? 0), 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)

    console.log('\n📊 Export Summary:')
    console.log('==================')
    console.log(`📁 Folder: ${normalizedPath}`)
    console.log(`📄 Files exported: ${folderObjects.length}`)
    console.log(`💾 Total size: ${totalSizeGB} GB`)
    console.log(`📝 CSV file: ${outputPath}`)

    // Show top 10 biggest files
    const topFiles = folderObjects
        .filter(obj => obj.Size && obj.Size > 0)
        .sort((a, b) => (b.Size ?? 0) - (a.Size ?? 0))
        .slice(0, 10)

    if (topFiles.length > 0) {
        console.log(`\n🏆 Top ${Math.min(10, topFiles.length)} biggest files:`)
        topFiles.forEach((file, index) => {
            const sizeMB = ((file.Size ?? 0) / (1024 * 1024)).toFixed(2)
            const relativePath = file.Key?.substring(normalizedPath.length) ?? ''
            console.log(`${(index + 1).toString().padStart(2, '0')}. ${relativePath} - ${sizeMB} MB`)
        })
    }

    console.log(`\n✅ Successfully exported to: ${outputPath}`)
}

function existInEnv(s: string) {
    return process.env[s] !== undefined
}

export function getDatabaseURL(): string {
    // TODO: uncomment when we enable back replicate
    // const clientContinent = (c.req.raw as any)?.cf?.continent
    // cloudlog({ requestId: c.get('requestId'), message: 'clientContinent', clientContinent  })
    let DEFAULT_DB_URL = getEnv('SUPABASE_DB_URL')
    if (existInEnv('MAIN_SUPABASE_DB_URL'))
        DEFAULT_DB_URL = getEnv('MAIN_SUPABASE_DB_URL')

    // if (!clientContinent)
    //   return DEFAULT_DB_URL
    // Hyperdrive test
    if (existInEnv('HYPERDRIVE_CAPGO_DIRECT_EU'))
        return (getEnv('HYPERDRIVE_CAPGO_DIRECT_EU') as any).connectionString

    // // Default to Germany for any other cases
    return DEFAULT_DB_URL
}

export function getPgClient(c: Context) {
    const dbUrl = getDatabaseURL()
    console.log({ message: 'getPgClient', dbUrl })
    return new Pool({
        connectionString: dbUrl,
        max: 1,
        idleTimeoutMillis: 2000,
    })
}

async function get_app_versions() {
    console.log('🔄 Connecting to database...')

    // Create a mock context for getPgClient
    const mockContext = {} as Context
    const pool = getPgClient(mockContext)

    try {
        console.log('📊 Fetching all app versions...')

        // Execute the query to get all app_versions as JSON
        const result = await pool.query('SELECT json_agg(app_versions.*) as data FROM app_versions')
        const appVersions = result.rows[0].data ?? []

        console.log(`✅ Found ${appVersions.length} app versions`)

        // Write to JSON file - data is already in JSON format
        const outputFile = './app_versions.json'
        writeFileSync(outputFile, JSON.stringify(appVersions, null, 2))

        console.log(`💾 Saved app versions to: ${outputFile}`)

    } catch (error) {
        console.error('❌ Error fetching app versions:', error)
        process.exit(1)
    } finally {
        // Close the database connection
        console.log('🔒 Closing database connection...')
        await pool.end()
        console.log('✅ Database connection closed')
    }
}

async function get_big_orgs() {
    console.log('🔄 Analyzing organization storage usage...')

    // Check if required files exist
    const appVersionsFile = './app_versions.json'
    const objectsFile = './objects.json'

    if (!existsSync(appVersionsFile)) {
        console.error('❌ No app_versions.json file found. Run "get_app_versions" first.')
        process.exit(1)
    }

    if (!existsSync(objectsFile)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading app versions and objects data...')

    // Load both files
    const appVersions = JSON.parse(readFileSync(appVersionsFile, 'utf-8'))
    const objects: _Object[] = JSON.parse(readFileSync(objectsFile, 'utf-8'))

    console.log(`📊 Loaded ${appVersions.length} app versions and ${objects.length} objects`)

    // Create a map of r2_path -> size for fast lookup
    console.log('🗺️  Creating object size lookup map...')
    const objectSizeMap = new Map<string, number>()
    objects.forEach(obj => {
        if (obj.Key && obj.Size) {
            objectSizeMap.set(obj.Key, obj.Size)
        }
    })

    // Process app versions to calculate org sizes
    console.log('🔍 Processing app versions to calculate org storage usage...')
    const orgSizes = new Map<string, number>()
    let foundVersions = 0
    let missingVersions = 0

    appVersions.forEach((version: any) => {
        if (version.r2_path && version.owner_org) {
            const size = objectSizeMap.get(version.r2_path)
            if (size) {
                const currentSize = orgSizes.get(version.owner_org)?? 0
                orgSizes.set(version.owner_org, currentSize + size)
                foundVersions++
            } else {
                missingVersions++
            }
        }
    })

    console.log(`✅ Found sizes for ${foundVersions} versions, ${missingVersions} missing from R2`)

    // Sort organizations by total size (descending)
    const sortedOrgs = Array.from(orgSizes.entries())
        .map(([orgId, size]) => ({ orgId, size }))
        .sort((a, b) => b.size - a.size)

    console.log(`📊 Found ${sortedOrgs.length} organizations with storage usage`)

    // Filter orgs over 100 MB and fetch their plan information
    const orgsOver100MB = sortedOrgs.filter(org => org.size > 100 * 1024 * 1024) // 100 MB in bytes
    console.log(`💳 Fetching plan information for ${orgsOver100MB.length} organizations over 100 MB...`)

    let planInfoMap = new Map<string, any>()

    if (orgsOver100MB.length > 0) {
        // Create a mock context for getPgClient
        const mockContext = {} as Context
        const pool = getPgClient(mockContext)

        try {
            // Create all the plan queries
            const planQueries = orgsOver100MB.map(org =>
                pool.query(
                    `select name, storage from plans
                    where price_m_id=(select price_id from stripe_info where customer_id=(select customer_id from orgs where id = $1))
                    or price_y_id=(select price_id from stripe_info where customer_id=(select customer_id from orgs where id = $1))`,
                    [org.orgId]
                )
            )

            // Execute all queries in parallel
            console.log('⚡ Running plan queries in parallel...')
            const planResults = await Promise.all(planQueries)

            // Map results back to org IDs
            orgsOver100MB.forEach((org, index) => {
                const planResult = planResults[index]
                if (planResult && planResult.rows.length > 0) {
                    planInfoMap.set(org.orgId, planResult.rows[0])
                }
            })

            console.log(`✅ Found plan information for ${planInfoMap.size}/${orgsOver100MB.length} organizations`)

        } catch (error) {
            console.error('❌ Error fetching plan information:', error)
        } finally {
            // Close the database connection
            await pool.end()
        }
    }

    // Generate report content
    const reportLines: string[] = []
    reportLines.push('Organization Storage Usage Report')
    reportLines.push('=====================================')
    reportLines.push(`Generated: ${new Date().toISOString()}`)
    reportLines.push(`Total Organizations: ${sortedOrgs.length}`)
    reportLines.push(`App Versions Processed: ${foundVersions}`)
    reportLines.push(`Organizations with Plan Info: ${planInfoMap.size}`)
    reportLines.push('')

    sortedOrgs.forEach((org, index) => {
        const sizeGB = (org.size / (1024 * 1024 * 1024)).toFixed(2)
        const sizeMB = (org.size / (1024 * 1024)).toFixed(2)
        const displaySize = parseFloat(sizeGB) >= 0.01 ? `${sizeGB} GB` : `${sizeMB} MB`

        let reportLine = `${(index + 1).toString().padStart(3, '0')}. org: ${org.orgId} || size: ${displaySize}`

        // Add plan information if available
        const planInfo = planInfoMap.get(org.orgId)
        if (planInfo) {
            const planStorageGB = planInfo.storage ? (planInfo.storage / (1024 * 1024 * 1024)).toFixed(0) : 'N/A'
            reportLine += ` || plan: ${planInfo.name || 'Unknown'}, storage: ${planStorageGB} GB`
        }

        reportLines.push(reportLine)
    })

    // Calculate total storage
    const totalSize = sortedOrgs.reduce((sum, org) => sum + org.size, 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)

    reportLines.push('')
    reportLines.push('Summary:')
    reportLines.push(`Total Storage Used: ${totalSizeGB} GB`)
    reportLines.push(`Average per Org: ${(parseFloat(totalSizeGB) / sortedOrgs.length).toFixed(2)} GB`)

    // Write report to file
    const outputFile = './big_orgs_report.txt'
    writeFileSync(outputFile, reportLines.join('\n'))

    console.log('\n📈 Top 10 Organizations by Storage:')
    console.log('====================================')
    sortedOrgs.slice(0, 10).forEach((org, index) => {
        const sizeGB = (org.size / (1024 * 1024 * 1024)).toFixed(2)
        let line = `${(index + 1).toString().padStart(2, '0')}. ${org.orgId} - ${sizeGB} GB`

        // Add plan info if available
        const planInfo = planInfoMap.get(org.orgId)
        if (planInfo) {
            const planStorageGB = planInfo.storage ? (planInfo.storage / (1024 * 1024 * 1024)).toFixed(0) : 'N/A'
            line += ` (Plan: ${planInfo.name || 'Unknown'}, ${planStorageGB} GB)`
        }

        console.log(line)
    })

    console.log(`\n💾 Total Storage: ${totalSizeGB} GB`)
    console.log(`✅ Full report saved to: ${outputFile}`)
}

async function export_supabase_csv(orgId: string) {
    console.log(`🔄 Exporting bundle information for organization: ${orgId}`)

    // Check if required files exist
    const appVersionsFile = './app_versions.json'
    const objectsFile = './objects.json'

    if (!existsSync(appVersionsFile)) {
        console.error('❌ No app_versions.json file found. Run "get_app_versions" first.')
        process.exit(1)
    }

    if (!existsSync(objectsFile)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading app versions and objects data...')

    // Load both files
    const appVersions = JSON.parse(readFileSync(appVersionsFile, 'utf-8'))
    const objects: _Object[] = JSON.parse(readFileSync(objectsFile, 'utf-8'))

    console.log(`📊 Loaded ${appVersions.length} app versions and ${objects.length} objects`)

    // Filter app versions for the specified organization
    const orgVersions = appVersions.filter((version: any) => version.owner_org === orgId)

    if (orgVersions.length === 0) {
        console.error(`❌ No app versions found for organization: ${orgId}`)
        console.error('💡 Make sure the organization ID is correct')
        return
    }

    console.log(`🎯 Found ${orgVersions.length} app versions for organization: ${orgId}`)

    // Create a set of r2_path from local objects to check existence
    console.log('🗺️  Creating object existence lookup from local data...')
    const localObjectsSet = new Set<string>()
    objects.forEach(obj => {
        if (obj.Key) {
            localObjectsSet.add(obj.Key)
        }
    })

    // Initialize S3 client for R2
    console.log('🔗 Connecting to R2...')
    const s3 = await initS3()

    // Filter versions that have r2_path AND exist in local objects
    const versionsWithR2 = orgVersions.filter((version: any) =>
        version.r2_path && localObjectsSet.has(version.r2_path)
    )
    console.log(`📦 Found ${versionsWithR2.length} versions with R2 paths that exist in local objects`)

    // Fetch actual sizes from R2 in parallel
    console.log('⚡ Fetching actual bundle sizes from R2 in parallel...')
    const sizeQueries = versionsWithR2.map(async (version: any) => {
        try {
            const response = await s3.send(new HeadObjectCommand({
                Bucket: S3_BUCKET,
                Key: version.r2_path
            }))
            return {
                version,
                size: response.ContentLength?? 0,
                found: true
            }
        } catch (error: any) {
            if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                return {
                    version,
                    size: 0,
                    found: false
                }
            } else {
                console.error(`❌ Error fetching ${version.r2_path}:`, error.message)
                return {
                    version,
                    size: 0,
                    found: false
                }
            }
        }
    })

    // Execute all queries in parallel
    const sizeResults = await Promise.all(sizeQueries)

    // Process versions and create CSV data
    console.log('📊 Processing versions and generating CSV data...')
    const csvData: any[] = []
    let foundSizes = 0
    let missingSizes = 0

    // Process all versions (including those without r2_path)
    orgVersions.forEach((version: any) => {
        let sizeBytes = 0
        let found = false

        if (version.r2_path) {
            const sizeResult = sizeResults.find(result => result.version.id === version.id)
            if (sizeResult) {
                sizeBytes = sizeResult.size
                found = sizeResult.found
                if (found) {
                    foundSizes++
                } else {
                    missingSizes++
                }
            }
        } else {
            missingSizes++
        }

        const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(6)
        const webLink = `https://console.capgo.app/app/${version.app_id}/bundle/${version.id}`

        csvData.push({
            app_id: version.app_id ?? '',
            version_name: version.name ?? '',
            version_id: version.id ?? '',
            size_bytes: sizeBytes,
            size_gb: sizeGB,
            link: webLink
        })
    })

    console.log(`✅ Found sizes for ${foundSizes} versions, ${missingSizes} missing/no R2 path`)

    // Sort by size (descending)
    csvData.sort((a, b) => b.size_bytes - a.size_bytes)

    // Create CSV content
    const csvHeaders = [
        'app_id',
        'version_name',
        'version_id',
        'size_bytes',
        'size_gb',
        'link'
    ]

    const csvRows = csvData.filter(row => row.size_bytes > 0).map(row => [
        `"${row.app_id}"`,
        `"${row.version_name}"`,
        row.version_id,
        row.size_bytes,
        row.size_gb,
        `"${row.link}"`
    ].join(','))

    const csvContent = [csvHeaders.join(','), ...csvRows].join('\n')

    // Generate output filename
    const sanitizedOrgId = orgId.replace(/[^\w-]/g, '_')
    const outputPath = `./org_${sanitizedOrgId}_bundles.csv`

    // Write CSV file
    writeFileSync(outputPath, csvContent)

    // Calculate statistics
    const totalSize = csvData.reduce((sum, row) => sum + row.size_bytes, 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)
    const avgSizeGB = csvData.length > 0 ? (totalSize / csvData.length / (1024 * 1024 * 1024)).toFixed(2) : '0'

    // Get unique apps
    const uniqueApps = new Set(csvData.map(row => row.app_id))

    console.log('\n📊 Export Summary:')
    console.log('==================')
    console.log(`🏢 Organization: ${orgId}`)
    console.log(`📱 Unique Apps: ${uniqueApps.size}`)
    console.log(`📦 Total Bundles: ${csvData.length}`)
    console.log(`💾 Total Size: ${totalSizeGB} GB`)
    console.log(`📈 Average Bundle Size: ${avgSizeGB} GB`)
    console.log(`📝 CSV file: ${outputPath}`)

    // Show top 10 biggest bundles
    const topBundles = csvData.slice(0, 10)
    if (topBundles.length > 0) {
        console.log(`\n🏆 Top ${Math.min(10, topBundles.length)} biggest bundles:`)
        topBundles.forEach((bundle, index) => {
            const sizeMB = (bundle.size_bytes / (1024 * 1024)).toFixed(2)
            console.log(`${(index + 1).toString().padStart(2, '0')}. ${bundle.app_id}@${bundle.version_name} - ${sizeMB} MB`)
        })
    }

    console.log(`\n✅ Successfully exported to: ${outputPath}`)
}

async function prepare_cleanup_zip() {
    console.log('🔄 Analyzing zip files for cleanup candidates...')

    // Check if required files exist
    const objectsFile = './objects.json'

    if (!existsSync(objectsFile)) {
        console.error('❌ No objects.json file found. Run "fetch_objects" first.')
        process.exit(1)
    }

    console.log('📂 Loading objects data...')

    // Load objects file
    const objects: _Object[] = JSON.parse(readFileSync(objectsFile, 'utf-8'))

    console.log(`📊 Loaded ${objects.length} objects`)

    // Filter for zip files that are direct children of apps folders
    const zipFiles = objects.filter(obj => {
        if (!obj.Key || !obj.Key.endsWith('.zip')) {
            return false
        }

        // Check if the file is a direct child of an apps folder
        // Expected pattern: orgs/{org-id}/apps/{app-id}/{version}.zip
        const pathParts = obj.Key.split('/')

        // Find the index of 'apps' in the path
        const appsIndex = pathParts.findIndex(part => part === 'apps')

        if (appsIndex === -1) {
            return false // No 'apps' folder in path
        }

        // Check if the zip file is exactly 2 levels deep from the apps folder
        // apps/{app-id}/{version}.zip means appsIndex + 2 should be the zip file
        const isDirectChild = appsIndex + 2 === pathParts.length - 1

        return isDirectChild
    })

    console.log(`📦 Found ${zipFiles.length} zip files`)

    if (zipFiles.length === 0) {
        console.log('✅ No zip files found to analyze')
        return
    }

    // Connect to database
    console.log('🔗 Connecting to database...')
    const mockContext = {} as Context
    const pool = getPgClient(mockContext)

    // Define types for cleanup data
    interface CleanupCandidate {
        key: string
        size: number
        lastModified: Date | null
        etag?: string | null
        reason: string
        error: string | null
    }

    try {
        // Check all zip files with a single database query for better performance
        console.log('⚡ Checking database records for all zip files with single optimized query...')

        // Extract all zip file keys
        const zipFileKeys = zipFiles.map(zipFile => zipFile.Key).filter(key => key !== undefined) as string[]

        // Single query to check all zip files at once
        const result = await pool.query(
            'SELECT r2_path FROM app_versions WHERE r2_path = ANY($1)',
            [zipFileKeys]
        )

        // Create a set of existing r2_paths for fast lookup
        const existingPaths = new Set(result.rows.map(row => row.r2_path))

        console.log(`✅ Found ${existingPaths.size} zip files with database records out of ${zipFiles.length} total`)

        // Process results
        const toDelete: CleanupCandidate[] = []
        let hasRecords = 0
        let orphaned = 0

        zipFiles.forEach(zipFile => {
            if (zipFile.Key && existingPaths.has(zipFile.Key)) {
                hasRecords++
            } else {
                orphaned++
                toDelete.push({
                    key: zipFile.Key ?? '',
                    size: zipFile.Size?? 0,
                    lastModified: zipFile.LastModified || null,
                    etag: zipFile.ETag ?? null,
                    reason: 'No matching app_versions record found',
                    error: null
                })
            }
        })

        console.log(`✅ Analysis complete:`)
        console.log(`   📦 Total zip files: ${zipFiles.length}`)
        console.log(`   ✅ With database records: ${hasRecords}`)
        console.log(`   🗑️  Orphaned (to delete): ${orphaned}`)

        // Calculate total size of files to delete
        const totalDeleteSize = toDelete.reduce((sum, file) => sum + file.size, 0)
        const totalDeleteSizeGB = (totalDeleteSize / (1024 * 1024 * 1024)).toFixed(2)

        console.log(`   💾 Total size to delete: ${totalDeleteSizeGB} GB`)

        // Save to JSON file
        const outputFile = './cleanup_candidates.json'
        const cleanupData = {
            generated: new Date().toISOString(),
            summary: {
                totalZipFiles: zipFiles.length,
                withDatabaseRecords: hasRecords,
                orphanedFiles: orphaned,
                totalSizeToDelete: totalDeleteSize,
                totalSizeToDeleteGB: parseFloat(totalDeleteSizeGB)
            },
            toDelete: toDelete.sort((a, b) => b.size - a.size) // Sort by size descending
        }

        writeFileSync(outputFile, JSON.stringify(cleanupData, null, 2))

        // Show top 10 biggest files to delete
        if (toDelete.length > 0) {
            console.log(`\n🏆 Top ${Math.min(10, toDelete.length)} biggest orphaned files:`)
            toDelete.slice(0, 10).forEach((file, index) => {
                const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
                console.log(`${(index + 1).toString().padStart(2, '0')}. ${file.key} - ${sizeMB} MB`)
            })
        }

        console.log(`\n✅ Cleanup candidates saved to: ${outputFile}`)

        if (orphaned > 0) {
            console.log(`\n⚠️  Found ${orphaned} orphaned zip files totaling ${totalDeleteSizeGB} GB`)
            console.log('💡 Review the cleanup_candidates.json file before proceeding with deletion')
        } else {
            console.log('\n🎉 No orphaned files found! All zip files have corresponding database records.')
        }

    } catch (error) {
        console.error('❌ Error during cleanup analysis:', error)
        process.exit(1)
    } finally {
        // Close the database connection
        console.log('🔒 Closing database connection...')
        await pool.end()
        console.log('✅ Database connection closed')
    }
}

async function copy_cleanup_candidates_to_backup_bucket() {
    console.log('🔄 Copying cleanup candidates to backup bucket...')

    const BACKUP_BUCKET = 'backup-cleanup-r2'

    // Check if cleanup_candidates.json exists
    const cleanupFile = './cleanup_candidates.json'

    if (!existsSync(cleanupFile)) {
        console.error('❌ No cleanup_candidates.json file found. Run "prepare_cleanup_zip" first.')
        process.exit(1)
    }

    console.log('📂 Loading cleanup candidates...')

    // Load cleanup candidates file
    const cleanupData = JSON.parse(readFileSync(cleanupFile, 'utf-8'))
    const toDelete = cleanupData.toDelete ?? []

    if (toDelete.length === 0) {
        console.log('✅ No files to copy - cleanup candidates is empty')
        return
    }

    console.log(`📦 Found ${toDelete.length} files to copy to backup bucket`)

    // Initialize S3 client
    console.log('🔗 Connecting to R2...')
    const s3 = await initS3()

    // Calculate total size
    const totalSize = toDelete.reduce((sum: number, file: any) => sum + (file.size?? 0), 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)

    console.log(`💾 Total size to copy: ${totalSizeGB} GB`)
    console.log(`📁 From bucket: ${S3_BUCKET}`)
    console.log(`📁 To backup bucket: ${BACKUP_BUCKET}`)

    // Copy files in batches based on memory limit (3GB)
    console.log('⚡ Downloading and re-uploading files to backup bucket in memory-safe batches...')

    const MAX_MEMORY_BYTES = 3 * 1024 * 1024 * 1024 // 3GB
    const allResults: any[] = []
    let currentBatch: any[] = []
    let currentBatchSize = 0
    let batchNumber = 1

    // Group files into memory-safe batches
    const batches: any[][] = []

    for (const file of toDelete) {
        const fileSize = file.size?? 0

        // If adding this file would exceed memory limit, start a new batch
        if (currentBatchSize + fileSize > MAX_MEMORY_BYTES && currentBatch.length > 0) {
            batches.push(currentBatch)
            currentBatch = []
            currentBatchSize = 0
        }

        currentBatch.push(file)
        currentBatchSize += fileSize
    }

    // Add the final batch if it has files
    if (currentBatch.length > 0) {
        batches.push(currentBatch)
    }

    console.log(`📦 Processing ${toDelete.length} files in ${batches.length} memory-safe batches`)

    // Process each batch sequentially
    for (const batch of batches) {
        const batchSizeGB = (batch.reduce((sum, file) => sum + (file.size?? 0), 0) / (1024 * 1024 * 1024)).toFixed(2)
        console.log(`🔄 Processing batch ${batchNumber}/${batches.length}: ${batch.length} files (${batchSizeGB} GB)`)

        const copyOperations = batch.map(async (file: any) => {
            try {
                // Step 1: Download the object from source bucket
                const getCommand = new GetObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: file.key
                })

                const getResponse = await s3.send(getCommand)

                if (!getResponse.Body) {
                    throw new Error('No body in response')
                }

                // Convert the stream to buffer
                const chunks: Uint8Array[] = []
                const reader = getResponse.Body.transformToWebStream().getReader()

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    chunks.push(value)
                }

                const buffer = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0))
                let offset = 0
                for (const chunk of chunks) {
                    buffer.set(chunk, offset)
                    offset += chunk.length
                }

                // Step 2: Upload the object to backup bucket
                const putCommand = new PutObjectCommand({
                    Bucket: BACKUP_BUCKET,
                    Key: file.key,
                    Body: buffer,
                    ContentType: getResponse.ContentType,
                    ContentLength: getResponse.ContentLength,
                    Metadata: getResponse.Metadata
                })

                await s3.send(putCommand)

                return {
                    key: file.key,
                    success: true,
                    error: null
                }
            } catch (error: any) {
                console.error(`❌ Error downloading/uploading ${file.key}:`, error.message)
                return {
                    key: file.key,
                    success: false,
                    error: error.message
                }
            }
        })

        // Execute current batch in parallel
        const batchResults = await Promise.all(copyOperations)
        allResults.push(...batchResults)

        const batchSuccessful = batchResults.filter(r => r.success).length
        const batchFailed = batchResults.filter(r => !r.success).length

        console.log(`✅ Batch ${batchNumber} complete: ${batchSuccessful} successful, ${batchFailed} failed`)
        console.log(`📊 Overall progress: ${allResults.length}/${toDelete.length} files processed`)

        batchNumber++
    }

    // Execute all copy operations
    const results = allResults

    // Analyze results
    const successful = results.filter(r => r.success)
    const failed = results.filter(r => !r.success)

    console.log('\n📊 Copy Results:')
    console.log('================')
    console.log(`✅ Successfully downloaded and re-uploaded: ${successful.length} files`)
    console.log(`❌ Failed to download/upload: ${failed.length} files`)

    if (failed.length > 0) {
        console.log('\n💥 Failed downloads/uploads:')
        failed.forEach((failure, index) => {
            console.log(`${(index + 1).toString().padStart(2, '0')}. ${failure.key} - ${failure.error}`)
        })
    }

    // Save copy results
    const copyReport = {
        generated: new Date().toISOString(),
        summary: {
            totalFiles: toDelete.length,
            successfulCopies: successful.length,
            failedCopies: failed.length,
            totalSizeCopied: totalSize,
            totalSizeCopiedGB: parseFloat(totalSizeGB),
            sourceBucket: S3_BUCKET,
            backupBucket: BACKUP_BUCKET
        },
        successful: successful,
        failed: failed
    }

    const reportFile = './backup_copy_report.json'
    writeFileSync(reportFile, JSON.stringify(copyReport, null, 2))

    console.log(`\n📝 Copy report saved to: ${reportFile}`)

    if (successful.length === toDelete.length) {
        console.log('\n🎉 All files successfully downloaded and re-uploaded to backup bucket!')
        console.log('✅ Safe to proceed with deletion if needed')
    } else {
        console.log(`\n⚠️  ${failed.length} files failed to download/upload`)
        console.log('💡 Review failed operations before proceeding with any deletion')
    }

    console.log(`\n📈 Summary:`)
    console.log(`   📦 Files downloaded and re-uploaded: ${successful.length}/${toDelete.length}`)
    console.log(`   💾 Size transferred: ${totalSizeGB} GB`)
    console.log(`   📁 Backup bucket: ${BACKUP_BUCKET}`)
}

async function copy_cleanup_candidates_direct() {
    console.log('🔄 Copying cleanup candidates using direct S3 copy...')

    const BACKUP_BUCKET = 'backup-cleanup-r2'

    // Check if cleanup_candidates.json exists
    const cleanupFile = './cleanup_candidates.json'

    if (!existsSync(cleanupFile)) {
        console.error('❌ No cleanup_candidates.json file found. Run "prepare_cleanup_zip" first.')
        process.exit(1)
    }

    console.log('📂 Loading cleanup candidates...')

    // Load cleanup candidates file
    const cleanupData = JSON.parse(readFileSync(cleanupFile, 'utf-8'))
    const toDelete = cleanupData.toDelete ?? []

    if (toDelete.length === 0) {
        console.log('✅ No files to copy - cleanup candidates is empty')
        return
    }

    console.log(`📦 Found ${toDelete.length} files to copy to backup bucket`)

    // Initialize S3 client
    console.log('🔗 Connecting to R2...')
    const s3 = await initS3()

    // Calculate total size
    const totalSize = toDelete.reduce((sum: number, file: any) => sum + (file.size?? 0), 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)

    console.log(`💾 Total size to copy: ${totalSizeGB} GB`)
    console.log(`📁 From bucket: ${S3_BUCKET}`)
    console.log(`📁 To backup bucket: ${BACKUP_BUCKET}`)

    // Copy files in parallel using direct S3 copy
    console.log('⚡ Copying files to backup bucket using direct S3 copy...')

    const copyOperations = toDelete.map(async (file: any, index: number) => {
        try {
            const copyCommand = new CopyObjectCommand({
                Bucket: BACKUP_BUCKET,
                CopySource: `${S3_BUCKET}/${file.key}`,
                Key: file.key
            })

            await s3.send(copyCommand)

            // Log progress every 10 files
            if ((index + 1) % 10 === 0) {
                console.log(`📊 Progress: ${index + 1}/${toDelete.length} files copied`)
            }

            return {
                key: file.key,
                success: true,
                error: null
            }
        } catch (error: any) {
            console.error(`❌ Error copying ${file.key}:`, error.message)
            return {
                key: file.key,
                success: false,
                error: error.message
            }
        }
    })

    // Execute all copy operations in parallel
    const results = await Promise.all(copyOperations)

    // Analyze results
    const successful = results.filter(r => r.success)
    const failed = results.filter(r => !r.success)

    console.log('\n📊 Copy Results:')
    console.log('================')
    console.log(`✅ Successfully copied: ${successful.length} files`)
    console.log(`❌ Failed to copy: ${failed.length} files`)

    if (failed.length > 0) {
        console.log('\n💥 Failed copies:')
        failed.forEach((failure, index) => {
            console.log(`${(index + 1).toString().padStart(2, '0')}. ${failure.key} - ${failure.error}`)
        })
    }

    // Save copy results
    const copyReport = {
        generated: new Date().toISOString(),
        summary: {
            totalFiles: toDelete.length,
            successfulCopies: successful.length,
            failedCopies: failed.length,
            totalSizeCopied: totalSize,
            totalSizeCopiedGB: parseFloat(totalSizeGB),
            sourceBucket: S3_BUCKET,
            backupBucket: BACKUP_BUCKET,
            method: 'direct_s3_copy'
        },
        successful: successful,
        failed: failed
    }

    const reportFile = './backup_copy_direct_report.json'
    writeFileSync(reportFile, JSON.stringify(copyReport, null, 2))

    console.log(`\n📝 Copy report saved to: ${reportFile}`)

    if (successful.length === toDelete.length) {
        console.log('\n🎉 All files successfully copied to backup bucket!')
        console.log('✅ Safe to proceed with deletion if needed')
    } else {
        console.log(`\n⚠️  ${failed.length} files failed to copy`)
        console.log('💡 Review failed copies before proceeding with any deletion')
    }

    console.log(`\n📈 Summary:`)
    console.log(`   📦 Files copied: ${successful.length}/${toDelete.length}`)
    console.log(`   💾 Size copied: ${totalSizeGB} GB`)
    console.log(`   📁 Backup bucket: ${BACKUP_BUCKET}`)
    console.log(`   🔧 Method: Direct S3 Copy`)
}

async function delete_cleanup_candidates() {
    const deleteMode = resolveOpsDeleteMode({
        DRY_RUN: process.env.DRY_RUN,
        ALLOW_PERMANENT_R2_DELETE: process.env.ALLOW_PERMANENT_R2_DELETE,
    })

    if (deleteMode === 'permanent')
        console.warn('WARNING: ALLOW_PERMANENT_R2_DELETE=true — permanently deleting files from the main bucket!')
    else if (deleteMode === 'trash')
        console.log('Moving cleanup candidates to 7-day trash (set ALLOW_PERMANENT_R2_DELETE=true for permanent delete)')
    else
        console.log('Dry-run mode: listing cleanup candidates without modifying storage')

    console.log('🔄 Processing cleanup candidates in the main bucket...')

    // Safety check - ensure this is intentional
    console.log('\n🛡️  SAFETY CHECKS:')
    console.log('   - Make sure you have backed up these files first')
    if (deleteMode === 'permanent') {
        console.log('   - This operation cannot be undone')
        console.log('   - Files will be permanently removed from main bucket')
    }
    else if (deleteMode === 'trash') {
        console.log('   - Files move to deleted-after-7-days/ and remain recoverable for seven days')
        console.log('   - Source keys are removed from their live paths after the trash copy succeeds')
    }
    else {
        console.log('   - No objects will be modified in dry-run mode')
    }

    // Check if cleanup_candidates.json exists
    const cleanupFile = './cleanup_candidates.json'

    if (!existsSync(cleanupFile)) {
        console.error('❌ No cleanup_candidates.json file found. Run "prepare_cleanup_zip" first.')
        process.exit(1)
    }

    console.log('📂 Loading cleanup candidates...')

    // Load cleanup candidates file
    const cleanupData = JSON.parse(readFileSync(cleanupFile, 'utf-8'))
    const toDelete = (cleanupData.toDelete ?? []).filter((file: { key?: unknown }) => {
        if (typeof file?.key !== 'string' || !file.key) {
            console.warn('Skipping cleanup candidate with invalid key:', file)
            return false
        }
        return isLiveR2Key(file.key)
    })

    if (toDelete.length === 0) {
        console.log('✅ No files to delete - cleanup candidates is empty')
        return
    }

    console.log(`📦 Found ${toDelete.length} cleanup candidates in ${cleanupFile}`)

    console.log('🔗 Revalidating candidates against current app_versions...')
    const mockContext = {} as Context
    const pool = getPgClient(mockContext)
    let candidatesToProcess = toDelete
    try {
        const candidateKeys = candidatesToProcess.map((file: { key: string }) => file.key)
        const result = await pool.query(
            'SELECT r2_path FROM app_versions WHERE r2_path = ANY($1)',
            [candidateKeys],
        )
        const existingPaths = new Set(result.rows.map((row: { r2_path: string }) => row.r2_path))
        const beforeCount = candidatesToProcess.length
        candidatesToProcess = candidatesToProcess.filter((file: { key: string }) => !existingPaths.has(file.key))
        const skippedCount = beforeCount - candidatesToProcess.length
        if (skippedCount > 0)
            console.log(`⏭️  Skipping ${skippedCount} candidates that now have app_versions records`)
    }
    catch (error) {
        console.error('❌ Failed to revalidate cleanup candidates against database:', error)
        process.exit(1)
    }
    finally {
        await pool.end()
    }

    if (candidatesToProcess.length === 0) {
        console.log('✅ No orphaned files remain after DB revalidation')
        return
    }

    console.log(`📦 Processing ${candidatesToProcess.length} orphaned files from main bucket`)

    // Calculate total size
    const totalSize = candidatesToProcess.reduce((sum: number, file: any) => sum + (file.size?? 0), 0)
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2)

    console.log(`💾 Total size to ${deleteMode === 'dry_run' ? 'inspect' : 'process'}: ${totalSizeGB} GB`)
    console.log(`📁 From bucket: ${S3_BUCKET}`)

    if (deleteMode === 'dry_run') {
        for (const file of candidatesToProcess)
            console.log(`Would process: ${file.key}`)
        console.log(`✅ Dry-run complete for ${candidatesToProcess.length} live candidates`)
        return
    }

    // Initialize S3 client
    console.log('🔗 Connecting to R2...')
    const s3 = await initS3()

    const PROCESS_CONCURRENCY = 20
    const limiter = new ConcurrencyLimiter(PROCESS_CONCURRENCY)
    let processedCount = 0

    async function objectExists(key: string): Promise<boolean> {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
            return true
        }
        catch (error) {
            if (isObjectNotFoundError(error))
                return false
            throw error
        }
    }

    const trashDestinationResolver = createAwsTrashDestinationResolver(async (objectKey) => {
        const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }))
        return { etag: head.ETag }
    })

    async function processCandidate(file: { key: string, size?: number, lastModified?: string | Date | null, etag?: string | null }): Promise<{ key: string, success: boolean, error: string | null, skipped?: boolean, size?: number }> {
        try {
            let sourceEtag: string | undefined
            let sourceLastModified: Date | undefined
            try {
                const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: file.key }))
                if (file.size != null && head.ContentLength !== file.size) {
                    return {
                        key: file.key,
                        success: true,
                        error: 'Cleanup candidate stale: object size changed since prepare_cleanup_zip',
                        skipped: true,
                    }
                }
                if (file.lastModified && head.LastModified) {
                    const candidateTime = new Date(file.lastModified).getTime()
                    if (candidateTime !== head.LastModified.getTime()) {
                        return {
                            key: file.key,
                            success: true,
                            error: 'Cleanup candidate stale: object lastModified changed since prepare_cleanup_zip',
                            skipped: true,
                        }
                    }
                }
                if (file.etag && head.ETag && file.etag !== head.ETag) {
                    return {
                        key: file.key,
                        success: true,
                        error: 'Cleanup candidate stale: object etag changed since prepare_cleanup_zip',
                        skipped: true,
                    }
                }
                sourceEtag = head.ETag
                sourceLastModified = head.LastModified
            }
            catch (headError: any) {
                if (isObjectNotFoundError(headError))
                    return { key: file.key, success: true, error: null, skipped: true }
                return {
                    key: file.key,
                    success: false,
                    error: `Failed to head source before cleanup: ${headError.message}`,
                }
            }

            if (!sourceEtag || !sourceLastModified) {
                return {
                    key: file.key,
                    success: false,
                    error: 'Live object has no ETag or Last-Modified; source retained',
                }
            }

            if (deleteMode === 'permanent') {
                try {
                    const deleteCommand = new DeleteObjectCommand({
                        Bucket: S3_BUCKET,
                        Key: file.key,
                        IfMatch: sourceEtag,
                    })
                    applyR2ConditionalDeleteMiddleware(deleteCommand.middlewareStack, { etag: sourceEtag, lastModified: sourceLastModified })
                    await s3.send(deleteCommand)
                }
                catch (deleteError: any) {
                    if (isObjectNotFoundError(deleteError))
                        return { key: file.key, success: true, error: null, skipped: true }
                    if (isPreconditionFailedError(deleteError)) {
                        return {
                            key: file.key,
                            success: true,
                            error: 'Cleanup candidate stale: live object changed before permanent delete',
                            skipped: true,
                        }
                    }
                    throw deleteError
                }
            }
            else {
                const trashKey = await resolveTrashDestinationKey(trashDestinationResolver, file.key, sourceEtag)

                try {
                    await s3.send(new CopyObjectCommand({
                        Bucket: S3_BUCKET,
                        CopySource: encodeS3CopySource(S3_BUCKET, file.key),
                        Key: trashKey,
                    }))
                }
                catch (copyError: any) {
                    try {
                        const trashExists = await objectExists(trashKey)
                        const sourceExists = await objectExists(file.key)
                        if (isAlreadyMovedToTrash(trashExists, sourceExists) || !sourceExists)
                            return { key: file.key, success: true, error: null, skipped: true }
                    }
                    catch (headError: any) {
                        return {
                            key: file.key,
                            success: false,
                            error: `Failed to verify trash resume state: ${headError.message}`,
                        }
                    }
                    return { key: file.key, success: false, error: copyError.message }
                }

                try {
                    const deleteCommand = new DeleteObjectCommand({
                        Bucket: S3_BUCKET,
                        Key: file.key,
                        IfMatch: sourceEtag,
                    })
                    applyR2ConditionalDeleteMiddleware(deleteCommand.middlewareStack, { etag: sourceEtag, lastModified: sourceLastModified })
                    await s3.send(deleteCommand)
                }
                catch (deleteError: any) {
                    if (isObjectNotFoundError(deleteError))
                        return { key: file.key, success: true, error: null, skipped: true }
                    if (isPreconditionFailedError(deleteError))
                        return {
                            key: file.key,
                            success: true,
                            error: 'Copied to trash but live object changed before delete; source key retained',
                            skipped: true,
                        }
                    return {
                        key: file.key,
                        success: false,
                        error: `Copied to trash but failed to delete source: ${deleteError.message}`,
                    }
                }
            }

            return { key: file.key, success: true, error: null, size: file.size ?? 0 }
        }
        catch (error: any) {
            console.error(`❌ Error processing ${file.key}:`, error.message)
            return { key: file.key, success: false, error: error.message }
        }
    }

    console.log(`⚡ Processing files from main bucket (mode: ${deleteMode})...`)

    const results: Array<{ key: string, success: boolean, error: string | null, skipped?: boolean, size?: number }> = []
    for (let i = 0; i < candidatesToProcess.length; i += PROCESS_CONCURRENCY) {
        const batch = candidatesToProcess.slice(i, i + PROCESS_CONCURRENCY)
        const batchResults = await Promise.all(batch.map((file: { key: string }) => limiter.run(() => processCandidate(file))))
        results.push(...batchResults)
        processedCount += batchResults.length
        if (processedCount % 10 === 0 || processedCount === candidatesToProcess.length)
            console.log(`📊 Progress: ${processedCount}/${candidatesToProcess.length} files processed`)
    }

    // Analyze results
    const successful = results.filter(r => r.success && !r.skipped)
    const skipped = results.filter(r => r.success && r.skipped)
    const failed = results.filter(r => !r.success)
    const processedSize = successful.reduce((sum, result) => sum + (result.size ?? 0), 0)
    const processedSizeGB = (processedSize / (1024 * 1024 * 1024)).toFixed(2)

    console.log('\n📊 Delete Results:')
    console.log('================')
    console.log(`✅ Successfully processed: ${successful.length} files`)
    console.log(`⏭️  Safely skipped: ${skipped.length} files`)
    console.log(`❌ Failed to process: ${failed.length} files`)

    if (failed.length > 0) {
        console.log('\n💥 Failed deletions:')
        failed.forEach((failure, index) => {
            console.log(`${(index + 1).toString().padStart(2, '0')}. ${failure.key} - ${failure.error}`)
        })
    }

    // Save delete results
    const deleteReport = {
        generated: new Date().toISOString(),
        deleteMode,
        summary: {
            totalFiles: candidatesToProcess.length,
            successfulProcessed: successful.length,
            skippedProcessed: skipped.length,
            failedProcessed: failed.length,
            totalSizeCandidates: totalSize,
            totalSizeCandidatesGB: parseFloat(totalSizeGB),
            totalSizeProcessed: processedSize,
            totalSizeProcessedGB: parseFloat(processedSizeGB),
            sourceBucket: S3_BUCKET,
        },
        successful,
        skipped,
        failed,
    }

    const reportFile = './delete_report.json'
    writeFileSync(reportFile, JSON.stringify(deleteReport, null, 2))

    console.log(`\n📝 Delete report saved to: ${reportFile}`)

    if (failed.length > 0) {
        console.log(`\n⚠️  ${failed.length} files failed to process`)
        console.log('💡 Review failed operations in the report')
        process.exit(1)
    }

    if (failed.length === 0) {
        console.log(`\n🎉 Cleanup finished with no failures (${successful.length} processed, ${skipped.length} safely skipped)`)
        console.log('✅ Cleanup operation completed successfully')
    }

    console.log(`\n📈 Summary:`)
    console.log(`   📦 Files ${deleteMode === 'permanent' ? 'deleted' : 'moved to trash'}: ${successful.length}/${candidatesToProcess.length}`)
    console.log(`   ⏭️  Safely skipped: ${skipped.length}`)
    console.log(`   💾 Size ${deleteMode === 'permanent' ? 'deleted' : 'moved to trash'}: ${processedSizeGB} GB`)
    console.log(`   📁 Source bucket: ${S3_BUCKET}`)
}

main()
