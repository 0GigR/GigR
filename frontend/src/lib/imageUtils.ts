import heic2any from 'heic2any'
import { toast } from 'sonner'

export async function processImageFile(file: File): Promise<File> {
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' || 
                 file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif');
                 
  if (!isHeic) {
    return file;
  }

  const toastId = toast.loading('Processing image format...')
  try {
    const convertedBlob = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.8
    });
    
    const blobToUse = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
    
    // Create a new File object
    const newName = file.name.replace(/\.heic$|\.heif$/i, '.jpg');
    toast.dismiss(toastId)
    return new File([blobToUse], newName, { type: 'image/jpeg' });
  } catch (error) {
    console.error("Error converting HEIC image:", error);
    toast.dismiss(toastId)
    toast.error('Failed to process image format, falling back to original')
    // Return original if conversion fails
    return file;
  }
}
