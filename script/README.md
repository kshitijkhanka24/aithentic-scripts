# Aithentic Assignment Grading System - Script

This Node.js script fetches PDF assignments from an AWS S3 bucket, downloads them locally, and converts them to plain text files using `pdf-parse` (with a fallback to the system `pdftotext` utility).

## Prerequisites

### System Dependencies

The script requires **poppler-utils** for the `pdftotext` fallback converter. This is essential if `pdf-parse` fails to initialize properly (which can happen due to module export variations).

#### Install on Linux (Debian/Ubuntu)
```bash
sudo apt-get update
sudo apt-get install -y poppler-utils
```

#### Install on Linux (Red Hat/CentOS/Fedora)
```bash
sudo yum install -y poppler-utils
```

#### Install on macOS
```bash
brew install poppler
```

#### Install on Windows
- Download and install Poppler from [here](https://github.com/oschwartz10612/poppler-windows/releases/)
- Add the `bin` directory to your PATH.

### Node.js Dependencies

All Node.js dependencies are listed in `package.json`:
```bash
npm install
# or if using pnpm:
pnpm install
```

## Configuration

The script reads configuration from environment variables or uses defaults:

| Environment Variable | Default | Description |
|---|---|---|
| `AWS_REGION` | `ap-south-1` | AWS region where the S3 bucket is located |
| `AWS_DEFAULT_REGION` | (none) | Fallback AWS region if `AWS_REGION` is not set |
| `S3_BUCKET` | `aithentic-assignment-bucket` | S3 bucket name |
| `ASSIGNMENTS_BUCKET` | (none) | Fallback bucket name if `S3_BUCKET` is not set |
| `ASSIGNMENTS_PREFIX` | `assignments/` | S3 prefix (folder path) where PDFs are stored; set to empty string `''` for bucket root |
| `CONVERTED_PREFIX` | `converted/` | S3 prefix for converted files (currently unused; files save locally) |
| `S3_DIAGNOSE` | (none) | Set to `'true'` to run AWS CLI diagnostics if region auto-detection fails |

## Setup on EC2 Instance

### 1. Install System Dependencies

```bash
sudo apt-get update
sudo apt-get install -y poppler-utils
```

### 2. Install Node.js (if not already installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 3. Clone or copy the script to the instance

```bash
cd /path/to/script
npm install
# or: pnpm install
```

### 4. Verify S3 Access

If the EC2 instance has an attached IAM role, it will use that for AWS credentials automatically. Otherwise, configure credentials:

```bash
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_SESSION_TOKEN=your-session-token  # if using temporary credentials
```

### 5. Run the Script

```bash
# If PDFs are in the bucket root (not in an `assignments/` folder):
export ASSIGNMENTS_PREFIX=''
node script.js

# Or if PDFs are in the `assignments/` folder (default):
node script.js

# Or with explicit bucket and region:
export AWS_REGION=us-east-1
export S3_BUCKET=my-bucket
export ASSIGNMENTS_PREFIX=''
node script.js
```

## Output

The script creates two local directories:

- **`./assignments/`** - Contains downloaded PDF files from S3.
- **`./converted/`** - Contains converted `.txt` files and a summary JSON.

### Conversion Summary

After conversion, a `_conversion_summary.json` file is written to `./converted/` with details:

```json
{
  "timestamp": "2025-11-18T18:09:46.686Z",
  "totalFiles": 2,
  "successfulConversions": 2,
  "files": [
    {
      "originalFile": "assignment.pdf",
      "textFile": "assignment.txt",
      "textPath": "converted/assignment.txt",
      "characterCount": 7600,
      "fallback": "pdftotext"
    }
  ]
}
```

The `fallback` field indicates which converter was used:
- If absent: `pdf-parse` was used successfully.
- If `"pdftotext"`: The system `pdftotext` utility was used as a fallback.

## Troubleshooting

### Error: `pdftotext: command not found`

**Solution:** Install poppler-utils (see [System Dependencies](#system-dependencies) above).

### Error: HTTP 403 from S3

**Cause:** The IAM role or credentials lack permissions.

**Solution:**
1. Verify the IAM role attached to the EC2 instance has these permissions:
   - `s3:ListBucket`
   - `s3:GetObject`
   - `s3:HeadBucket`
   - `s3:GetBucketLocation` (optional, for auto-detecting bucket region)
2. Check the bucket policy for restrictive rules.
3. Run the AWS CLI to verify access:
   ```bash
   aws s3api head-bucket --bucket your-bucket-name
   ```

### Error: HTTP 301 from S3 (Bucket in Wrong Region)

**Cause:** The bucket is in a different AWS region than the client.

**Solution:**
1. Determine the bucket region:
   ```bash
   aws s3api get-bucket-location --bucket your-bucket-name
   ```
2. Set the correct region:
   ```bash
   export AWS_REGION=<detected-region>
   node script.js
   ```

### Error: No PDFs downloaded

**Cause:** The `ASSIGNMENTS_PREFIX` doesn't match where PDFs are stored in the bucket.

**Solution:**
1. List objects in the bucket to find the correct prefix:
   ```bash
   aws s3api list-objects-v2 --bucket your-bucket-name --output table
   ```
2. Set `ASSIGNMENTS_PREFIX` accordingly:
   ```bash
   export ASSIGNMENTS_PREFIX=''          # for bucket root
   export ASSIGNMENTS_PREFIX='pdfs/'     # for `pdfs/` folder
   node script.js
   ```

### Error: PDF conversions failing but falling back to pdftotext

This is expected and handled gracefully. The script logs detailed errors and attempts fallback conversion. Check `./converted/_conversion_summary.json` to see which conversions succeeded and via which method.

## AWS IAM Policy Example

If you're setting up a new IAM role or user, here's a minimal policy for this script:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:HeadBucket"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
```

Replace `your-bucket-name` with the actual bucket name.

## Environment Variable Setup Example

Create a `.env` file (do not commit to version control) with:

```bash
AWS_REGION=ap-south-1
S3_BUCKET=aithentic-assignment-bucket
ASSIGNMENTS_PREFIX=
```

Then load it before running:

```bash
set -a
source .env
set +a
node script.js
```

## Scripts (Optional)

You can add convenience scripts to `package.json`:

```json
"scripts": {
  "start": "node script.js",
  "start:debug": "S3_DIAGNOSE=true node script.js"
}
```

Then run:
```bash
npm start
npm run start:debug
```

## Notes

- **PDF Conversion Method**: The script prefers `pdf-parse` but falls back to the system `pdftotext` utility if `pdf-parse` fails. `pdftotext` is fast and reliable for plain text extraction but may lose layout/structure.
- **Large Buckets**: If your bucket is very large and PDFs are at the root, the fallback listing (when prefix is `assignments/` but no files found) may take a while. Use `ASSIGNMENTS_PREFIX=''` explicitly to skip the prefix and list directly.
- **Error Handling**: The script continues processing remaining files even if one conversion fails. Check `_conversion_summary.json` to see which files succeeded.

## Support

For issues or questions, check:
1. The script's console output for detailed error messages.
2. The `_conversion_summary.json` file for a summary of conversions.
3. AWS CloudTrail logs for S3 access issues.
4. IAM role/policy configuration for permission issues.
