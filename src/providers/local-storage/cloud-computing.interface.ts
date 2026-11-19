export interface CloudComputingOptions {
  file?: Express.Multer.File;
  path?: string;
  name?: string;
  bucket?: string;
  key?: string;
  contentType?: string;
  contentDisposition?: string;
}

export interface CloudComputingResponse {
  path: string;
  url: string;
}

export interface CloudComputing {
  uploadFile(fileOptions: CloudComputingOptions): Promise<CloudComputingResponse>;
  deleteFile(fileOptions: CloudComputingOptions): Promise<boolean>;
  getFile(fileOptions: CloudComputingOptions): Promise<Buffer>;
}