import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import editly from 'editly';
import { fileURLToPath } from 'url';
import livereload from 'livereload';
import connectLivereload from 'connect-livereload';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Set up live reload server
const liveReloadServer = livereload.createServer();
liveReloadServer.watch([
  path.join(__dirname, 'public'),
  path.join(__dirname, 'uploads'),
  path.join(__dirname, 'videos')
]);

// Add livereload middleware to express
app.use(connectLivereload());

// Set up storage for uploaded files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Serve static files
app.use(express.static('public'));
app.use('/videos', express.static('videos'));
app.use('/uploads', express.static('uploads'));

// Configure AWS S3
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'your-bucket-name';

// Ensure required directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const tempDir = path.join(__dirname, 'temp');

// Create directories if they don't exist
[uploadsDir, tempDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle image upload and background removal
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const imagePath = req.file.path;
    
    // Ensure the file exists before trying to read it
    if (!fs.existsSync(imagePath)) {
      throw new Error(`File not found: ${imagePath}`);
    }
    
    // Upload the image to S3
    const s3Key = `uploads/${path.basename(imagePath)}`;
    const fileContent = fs.readFileSync(imagePath);
    
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileContent,
      ContentType: 'image/png'
    };
    
    await s3Client.send(new PutObjectCommand(uploadParams));
    
    // Generate a presigned URL for the uploaded image
    const getObjectParams = {
      Bucket: BUCKET_NAME,
      Key: s3Key
    };
    
    const presignedUrl = await getSignedUrl(
      s3Client, 
      new GetObjectCommand(getObjectParams), 
      { expiresIn: 3600 } // URL expires in 1 hour
    );
    
    res.json({
      success: true,
      imagePath: imagePath, // Keep the local path for backward compatibility
      s3Key: s3Key, // Add S3 key for reference
      imageUrl: presignedUrl // Add the S3 URL
    });
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create video from processed image
app.post('/create-video', express.json(), async (req, res) => {
  try {
    const { imagePath, s3Key, text } = req.body;
    const videoId = uuidv4();
    const tempImagePath = path.join(tempDir, `temp-image-${videoId}.png`);
    const videoPath = path.join(tempDir, `${videoId}.mp4`);
    
    // Get the absolute path for the video file
    const videoFilePath = path.join(__dirname, 'assets/video.mp4');
    const audioFilePath = path.join(__dirname, 'assets/music.m4a');
    
    if (s3Key) {
      // Get the image from S3
      const getObjectParams = {
        Bucket: BUCKET_NAME,
        Key: s3Key
      };
      
      try {
        const { Body } = await s3Client.send(new GetObjectCommand(getObjectParams));
        const imageBuffer = await streamToBuffer(Body);
        fs.writeFileSync(tempImagePath, imageBuffer);
      } catch (s3Error) {
        console.error('Error fetching from S3:', s3Error);
        throw new Error(`Failed to fetch image from S3: ${s3Error.message}`);
      }
    } else if (imagePath) {
      // Fallback to local path if s3Key is not provided
      try {
        // Normalize the path to handle both absolute and relative paths
        const absoluteImagePath = path.isAbsolute(imagePath) 
          ? imagePath 
          : path.join(__dirname, imagePath.startsWith('/') ? imagePath.substring(1) : imagePath);
        
        if (!fs.existsSync(absoluteImagePath)) {
          throw new Error(`Local image file not found: ${absoluteImagePath}`);
        }
        
        fs.copyFileSync(absoluteImagePath, tempImagePath);
      } catch (fileError) {
        console.error('Error accessing local file:', fileError);
        throw new Error(`Failed to access local image: ${fileError.message}`);
      }
    } else {
      throw new Error('No image source provided (neither S3 key nor local path)');
    }
    
    // Create video with editly - mobile-friendly dimensions
    await editly({
      outPath: videoPath,
      width: 480,
      height: 854,
      fps: 30,
      audioTracks: [
        {
          path: audioFilePath,
          volume: 1 // Adjust volume as needed (0.0 to 1.0)
        }
      ],
      clips: [
        // Single clip with video background and image appearing after 3 seconds
        {
          duration: 9,
          layers: [
            // Video layer (background)
            {
              type: 'video',
              path: videoFilePath,
              position: "center",
              resizeMode: 'cover',
            },
            // Image layer (appears after 3 seconds)
            {
              type: 'image',
              path: tempImagePath,
              position: { x: 0.5, y: 0.45 }, // Position in middle area (moved up significantly)
              resizeMode: 'contain',
              start: 3, // Start showing after 3 seconds
              width: '10%', // Smaller to avoid overlap
              height: '10%', // Smaller to avoid overlap
            }
          ]
        }
      ]
    });
    
    // Upload the video to S3
    const s3VideoKey = `videos/hosamani-family-video-${videoId}.mp4`;
    
    try {
      const fileContent = fs.readFileSync(videoPath);
      
      const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: s3VideoKey,
        Body: fileContent,
        ContentType: 'video/mp4'
      };
      
      await s3Client.send(new PutObjectCommand(uploadParams));
    } catch (uploadError) {
      console.error('Error uploading video to S3:', uploadError);
      throw new Error(`Failed to upload video to S3: ${uploadError.message}`);
    }
    
    // Generate a presigned URL for the uploaded video (valid for 1 hour)
    const getObjectParams = {
      Bucket: BUCKET_NAME,
      Key: s3VideoKey
    };
    
    const presignedUrl = await getSignedUrl(
      s3Client, 
      new GetObjectCommand(getObjectParams), 
      { expiresIn: 3600 } // URL expires in 1 hour
    );
    
    // Delete the temporary local files
    try {
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
      
      if (fs.existsSync(tempImagePath)) {
        fs.unlinkSync(tempImagePath);
      }
    } catch (cleanupError) {
      console.error('Error cleaning up temporary files:', cleanupError);
      // Don't throw here, just log the error
    }
    
    // Return the presigned URL to the client
    res.json({
      success: true,
      videoUrl: presignedUrl,
      videoId: videoId
    });
  } catch (error) {
    console.error('Error creating video:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function to convert stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Add route for URL uploads
app.post('/upload-url', express.json(), async (req, res) => {
  try {
    const { url } = req.body;
    const filename = `url-image-${uuidv4()}.jpg`;
    const imagePath = path.join(uploadsDir, filename);
    
    // Download the image
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(imagePath, Buffer.from(buffer));
    
    // Upload to S3
    const s3Key = `uploads/${filename}`;
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: Buffer.from(buffer),
      ContentType: 'image/jpeg'
    };
    
    await s3Client.send(new PutObjectCommand(uploadParams));
    
    // Generate a presigned URL
    const getObjectParams = {
      Bucket: BUCKET_NAME,
      Key: s3Key
    };
    
    const presignedUrl = await getSignedUrl(
      s3Client, 
      new GetObjectCommand(getObjectParams), 
      { expiresIn: 3600 }
    );
    
    res.json({
      success: true,
      imagePath: imagePath,
      s3Key: s3Key,
      imageUrl: presignedUrl
    });
  } catch (error) {
    console.error('Error downloading image:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
}); 