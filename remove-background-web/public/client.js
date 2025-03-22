import { AutoModel, AutoProcessor, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0';

// Constants
const EXAMPLE_URL =
  "https://images.pexels.com/photos/5965592/pexels-photo-5965592.jpeg?auto=compress&cs=tinysrgb&w=1024";

// Reference the elements that we will need
const status = document.getElementById("status");
const fileUpload = document.getElementById("upload");
const imageContainer = document.getElementById("container");
const example = document.getElementById("example");
const cameraButton = document.getElementById("camera");

// Load model and processor
status.textContent = "Loading model...";

let model, processor;

async function loadModel() {
  try {
    model = await AutoModel.from_pretrained("briaai/RMBG-1.4", {
      // Do not require config.json to be present in the repository
    });

    processor = await AutoProcessor.from_pretrained("briaai/RMBG-1.4", {
      // Do not require config.json to be present in the repository
      config: {
        do_normalize: true,
        do_pad: false,
        do_rescale: true,
        do_resize: true,
        image_mean: [0.5, 0.5, 0.5],
        feature_extractor_type: "ImageFeatureExtractor",
        image_std: [1, 1, 1],
        resample: 2,
        rescale_factor: 0.00392156862745098,
        size: { width: 1024, height: 1024 },
      },
    });
    console.log("Model loaded successfully");
    status.textContent = "Ready";
  } catch (error) {
    console.error("Error loading model:", error);
    status.textContent = "Error loading model";
  }
}

// Initialize model loading
loadModel();

// Set up event listeners
example.addEventListener("click", (e) => {
  e.preventDefault();
  fetchAndProcessImage(EXAMPLE_URL);
});

fileUpload.addEventListener("change", function (e) {
  const file = e.target.files[0];
  if (!file) {
    return;
  }

  uploadAndProcessImage(file);
});

// Add camera button event listener
cameraButton.addEventListener("click", (e) => {
  e.preventDefault();
  openCamera();
});

// Function to handle example image
async function fetchAndProcessImage(url) {
  try {
    status.textContent = "Fetching example image...";
    
    // Process locally to remove background
    const processedImageData = await processImageLocally(url);
    
    // Convert data URL to blob
    const blob = await fetch(processedImageData).then(r => r.blob());
    const file = new File([blob], "processed-image.png", { type: "image/png" });
    
    // Send processed image to server
    const formData = new FormData();
    formData.append('image', file);
    
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      throw new Error('Failed to upload processed image');
    }
    
    const data = await response.json();
    
    // Add button to create video
    const createVideoBtn = document.createElement("button");
    createVideoBtn.textContent = "Create Naming Ceremony Video";
    createVideoBtn.id = "create-video-btn";
    createVideoBtn.addEventListener("click", () => createVideo(data.imagePath));
    imageContainer.appendChild(createVideoBtn);
    
    status.textContent = "Image processed successfully!";
  } catch (error) {
    console.error('Error:', error);
    status.textContent = 'Error processing image';
  }
}

// Function to handle file upload
async function uploadAndProcessImage(file) {
  try {
    status.textContent = "Processing image...";
    
    // Read the file as data URL for local processing
    const dataUrl = await readFileAsDataURL(file);
    
    // Process locally to remove background
    const processedImageData = await processImageLocally(dataUrl);
    
    // Convert data URL to blob
    const blob = await fetch(processedImageData).then(r => r.blob());
    const processedFile = new File([blob], "processed-image.png", { type: "image/png" });
    
    // Send processed image to server
    const formData = new FormData();
    formData.append('image', processedFile);
    
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      throw new Error('Failed to upload processed image');
    }
    
    const data = await response.json();
    
    // Add button to create video
    const createVideoBtn = document.createElement("button");
    createVideoBtn.textContent = "Create Naming Ceremony Video";
    createVideoBtn.id = "create-video-btn";
    createVideoBtn.addEventListener("click", () => createVideo(data.imagePath));
    imageContainer.appendChild(createVideoBtn);
    
    status.textContent = "Image processed successfully!";
  } catch (error) {
    console.error('Error:', error);
    status.textContent = 'Error processing image';
  }
}

// Helper function to read file as data URL
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Process image locally to remove background
async function processImageLocally(url) {
  try {
    // Read image
    const image = await RawImage.fromURL(url);

    // Update UI to show original image while processing
    imageContainer.innerHTML = "";
    imageContainer.style.backgroundImage = `url(${url})`;

    // Set container width and height depending on the image aspect ratio
    const ar = image.width / image.height;
    const [cw, ch] = ar > 720 / 480 ? [720, 720 / ar] : [480 * ar, 480];
    imageContainer.style.width = `${cw}px`;
    imageContainer.style.height = `${ch}px`;

    status.textContent = "Removing background...";

    // Preprocess image
    const { pixel_values } = await processor(image);

    // Predict alpha matte
    const { output } = await model({ input: pixel_values });

    // Resize mask back to original size
    const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(
      image.width,
      image.height,
    );
    image.putAlpha(mask);

    // Create new canvas
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image.toCanvas(), 0, 0);

    // Update UI - directly append the canvas instead of creating an img element
    imageContainer.innerHTML = "";
    imageContainer.append(canvas);
    imageContainer.style.removeProperty("background-image");
    imageContainer.style.background = `url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQBAMAAADt3eJSAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAGUExURb+/v////5nD/3QAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVBjTYwABQSCglEENMxgYGAAynwRB8BEAgQAAAABJRU5ErkJggg==")`;
    
    status.textContent = "Background removed successfully!";
    
    // Return the canvas data URL for potential further processing
    return canvas.toDataURL('image/png');
  } catch (error) {
    console.error("Error processing image locally:", error);
    status.textContent = "Error removing background";
    throw error;
  }
}

// Function to create video
async function createVideo(imagePath) {
  try {
    status.textContent = "Creating video...";
    
    const response = await fetch('/create-video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        imagePath,
        title: "Shlok's Naming Ceremony"
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to create video');
    }
    
    const data = await response.json();
    displayVideo(data.videoUrl);
  } catch (error) {
    console.error('Error:', error);
    status.textContent = 'Error creating video';
  }
}

// Function to display video
function displayVideo(videoUrl) {
  // Create video container
  const videoContainer = document.createElement("div");
  videoContainer.id = "video-container";
  
  // Create video element
  const videoElement = document.createElement("video");
  videoElement.src = videoUrl;
  videoElement.controls = true;
  videoElement.autoplay = true;
  videoElement.id = "video-result";
  
  // Create download link
  const downloadLink = document.createElement("a");
  downloadLink.href = videoUrl;
  downloadLink.download = "naming_ceremony.mp4";
  downloadLink.textContent = "Download Video";
  downloadLink.id = "download-video";
  
  // Add close button
  const closeButton = document.createElement("button");
  closeButton.textContent = "✕";
  closeButton.id = "close-video";
  closeButton.addEventListener("click", () => videoContainer.remove());
  
  // Add elements to container
  videoContainer.appendChild(videoElement);
  videoContainer.appendChild(downloadLink);
  videoContainer.appendChild(closeButton);
  
  // Add to page
  document.body.appendChild(videoContainer);
  
  status.textContent = "Video created successfully!";
}

// Function to open camera and capture image
async function openCamera() {
  try {
    // Create camera UI
    const cameraContainer = document.createElement("div");
    cameraContainer.id = "camera-container";
    
    const videoElement = document.createElement("video");
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.id = "camera-video";
    videoElement.setAttribute("playsinline", ""); // Important for iOS
    
    const captureButton = document.createElement("button");
    captureButton.textContent = "Take Photo";
    captureButton.id = "capture-photo";
    
    const closeButton = document.createElement("button");
    closeButton.textContent = "✕";
    closeButton.id = "close-camera";
    
    cameraContainer.appendChild(videoElement);
    cameraContainer.appendChild(captureButton);
    cameraContainer.appendChild(closeButton);
    document.body.appendChild(cameraContainer);
    
    // Access camera
    status.textContent = "Accessing camera...";
    const constraints = { 
      video: { 
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false 
    };
    
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = stream;
    
    // Wait for video to be ready
    await new Promise(resolve => {
      videoElement.onloadedmetadata = () => {
        videoElement.play().then(resolve);
      };
    });
    
    status.textContent = "Camera ready";
    
    // Set up close button
    closeButton.addEventListener("click", () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      cameraContainer.remove();
    });
    
    // Set up capture button
    captureButton.addEventListener("click", () => {
      // Create canvas to capture frame
      const canvas = document.createElement("canvas");
      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;
      const ctx = canvas.getContext("2d");
      
      // Draw the current video frame
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      
      // Convert to blob
      canvas.toBlob(async (blob) => {
        // Stop camera stream
        stream.getTracks().forEach(track => track.stop());
        cameraContainer.remove();
        
        // Process captured image
        const file = new File([blob], "camera-capture.png", { type: "image/png" });
        uploadAndProcessImage(file);
      }, "image/png", 0.9);
    });
  } catch (error) {
    console.error("Error accessing camera:", error);
    status.textContent = "Error accessing camera: " + error.message;
    
    // If there's a camera container, remove it
    const existingContainer = document.getElementById("camera-container");
    if (existingContainer) {
      existingContainer.remove();
    }
  }
} 