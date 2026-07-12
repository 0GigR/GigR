import heic2any from 'heic2any'

export async function processImageFile(file: File): Promise<File> {
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' || 
                 file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif');
                 
  if (!isHeic) {
    return file;
  }

  try {
    const convertedBlob = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.8
    });
    
    const blobToUse = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
    
    // Create a new File object
    const newName = file.name.replace(/\.heic$|\.heif$/i, '.jpg');
    return new File([blobToUse], newName, { type: 'image/jpeg' });
  } catch (error) {
    console.error("Error converting HEIC image:", error);
    // Return original if conversion fails
    return file;
  }
}
