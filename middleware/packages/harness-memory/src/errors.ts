export class MemoryPathNotFoundError extends Error {
  constructor(virtualPath: string) {
    super(`Path not found: ${virtualPath}`);
    this.name = 'MemoryPathNotFoundError';
  }
}

export class MemoryAlreadyExistsError extends Error {
  constructor(virtualPath: string) {
    super(`Path already exists: ${virtualPath}`);
    this.name = 'MemoryAlreadyExistsError';
  }
}

export class MemoryIsDirectoryError extends Error {
  constructor(virtualPath: string) {
    super(`Path is a directory, not a file: ${virtualPath}`);
    this.name = 'MemoryIsDirectoryError';
  }
}

export class MemoryInvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryInvalidPathError';
  }
}
