import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

interface DroneLogEntry {
  timestamp: string;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  battery: number;
  gpsSignal: number;
}

interface ProcessingStats {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  totalEntries: number;
}

class DJILogConverter {
  private inputFolder: string;
  private outputFolder: string;
  private apiKey: string;
  private stats: ProcessingStats;

  constructor(apiKey?: string) {
    this.inputFolder = path.join(__dirname, 'drone-logs');
    this.outputFolder = path.join(__dirname, 'csv-output');
    this.apiKey = apiKey || process.env.DJI_API_KEY || '';
    this.stats = {
      totalFiles: 0,
      successfulFiles: 0,
      failedFiles: 0,
      totalEntries: 0
    };
  }

  // Create necessary folders
  setupFolders(): void {
    if (!fs.existsSync(this.inputFolder)) {
      fs.mkdirSync(this.inputFolder, { recursive: true });
      console.log(`📁 Created input folder: ${this.inputFolder}`);
    }

    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, { recursive: true });
      console.log(`📁 Created output folder: ${this.outputFolder}`);
    }
  }

  // Enhanced method using multiple approaches
  async decryptWithDJILogParser(filePath: string): Promise<DroneLogEntry[]> {
    // Try binary method first (most reliable)
    try {
      return await this.useDJILogBinary(filePath);
    } catch (binaryError) {
      console.log(`🔧 Binary method failed: ${this.getErrorMessage(binaryError)}`);
    }

    // Try npm package method
    try {
      return await this.useNpmPackage(filePath);
    } catch (npmError) {
      console.log(`📦 NPM package method failed: ${this.getErrorMessage(npmError)}`);
    }

    // Fallback to manual methods
    console.log('🔄 Falling back to manual parsing methods...');
    return this.decryptWithFallbackMethod(filePath);
  }

  // Method 1: Using DJI Log Binary (Most Reliable)
  async useDJILogBinary(filePath: string): Promise<DroneLogEntry[]> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    const binaryPath = path.join(__dirname, 'dji-log.exe');
    if (!fs.existsSync(binaryPath)) {
      throw new Error('dji-log.exe not found. Download from https://github.com/lvauvillier/dji-log-parser/releases');
    }

    console.log('🔧 Using DJI log binary...');
    
    const timestamp = Date.now();
    const outputFile = path.join(__dirname, `temp-${timestamp}.csv`);
    
    try {
      let command = `"${binaryPath}"`;
      if (this.apiKey) {
        command += ` --api-key "${this.apiKey}"`;
      }
      command += ` --csv "${outputFile}" "${filePath}"`;

      console.log('⚙️  Executing DJI parser...');
      const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
      
      if (stderr && !stderr.includes('warning')) {
        console.warn('⚠️  Parser warnings:', stderr);
      }

      if (fs.existsSync(outputFile)) {
        const csvData = fs.readFileSync(outputFile, 'utf8');
        fs.unlinkSync(outputFile); // Clean up
        return this.parseCSVOutput(csvData);
      } else {
        throw new Error('CSV output file was not generated');
      }
    } catch (error) {
      // Clean up on error
      if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
      }
      throw error;
    }
  }

  // Method 2: Using npm package
  async useNpmPackage(filePath: string): Promise<DroneLogEntry[]> {
    console.log('📦 Trying npm package method...');
    
    try {
      const djiLogParser = require('dji-log-parser-js');
      const logBuffer = fs.readFileSync(filePath);
      
      const parser = djiLogParser.DJILog.fromBytes(logBuffer);
      console.log(`📋 Log version: ${parser.version}`);
      
      let frames;
      if (parser.version >= 13) {
        if (!this.apiKey) {
          throw new Error('DJI API key required for encrypted logs (version 13+)');
        }
        
        console.log('🔐 Fetching decryption keychains from DJI API...');
        const keychains = await parser.fetchKeychains(this.apiKey);
        frames = parser.frames(keychains);
      } else {
        frames = parser.frames(null);
      }

      return this.convertFramesToEntries(frames);
    } catch (error) {
      throw new Error(`NPM package failed: ${this.getErrorMessage(error)}`);
    }
  }

  // Parse CSV output from binary
  parseCSVOutput(csvData: string): DroneLogEntry[] {
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('No data in CSV output');
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    const entries: DroneLogEntry[] = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        const values = this.parseCSVLine(lines[i]);
        const entry: any = {};

        headers.forEach((header, index) => {
          if (values[index] !== undefined) {
            entry[header] = values[index];
          }
        });

        // Map to our standard format with better field matching
        const standardEntry: DroneLogEntry = {
          timestamp: this.extractField(entry, ['timestamp', 'datetime', 'time']) || new Date().toISOString(),
          latitude: this.extractNumericField(entry, ['latitude', 'lat', 'osd.latitude', 'custom.date.lat']),
          longitude: this.extractNumericField(entry, ['longitude', 'lng', 'lon', 'osd.longitude', 'custom.date.lng']),
          altitude: this.extractNumericField(entry, ['altitude', 'alt', 'osd.altitude', 'custom.date.altitude']),
          speed: this.extractNumericField(entry, ['speed', 'velocity', 'osd.hspeed', 'osd.vspeed', 'custom.date.hspeed']),
          battery: this.extractNumericField(entry, ['battery', 'battery.percent', 'osd.battery', 'custom.date.battery']),
          gpsSignal: this.extractNumericField(entry, ['gpssignal', 'gps', 'satellites', 'osd.gpslevel', 'custom.date.gpslevel'])
        };

        entries.push(standardEntry);
      } catch (error) {
        console.warn(`⚠️  Skipping invalid CSV line ${i + 1}`);
      }
    }

    return entries;
  }

  // Enhanced CSV line parsing
  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    values.push(current.trim());
    return values;
  }

  // Helper to extract field by multiple possible names
  private extractField(entry: any, fieldNames: string[]): string | undefined {
    for (const name of fieldNames) {
      if (entry[name] !== undefined && entry[name] !== '') {
        return String(entry[name]).replace(/"/g, '');
      }
    }
    return undefined;
  }

  // Helper to extract numeric field
  private extractNumericField(entry: any, fieldNames: string[]): number {
    for (const name of fieldNames) {
      if (entry[name] !== undefined && entry[name] !== '') {
        const value = parseFloat(String(entry[name]).replace(/"/g, ''));
        if (!isNaN(value)) {
          return value;
        }
      }
    }
    return 0;
  }

  // Convert frames to standard entries
  convertFramesToEntries(frames: any[]): DroneLogEntry[] {
    return frames.map((frame: any) => ({
      timestamp: frame.timestamp || frame.datetime || new Date().toISOString(),
      latitude: parseFloat(frame.latitude || frame.lat || frame.osd?.latitude || 0),
      longitude: parseFloat(frame.longitude || frame.lng || frame.lon || frame.osd?.longitude || 0),
      altitude: parseFloat(frame.altitude || frame.alt || frame.osd?.altitude || 0),
      speed: parseFloat(frame.speed || frame.velocity || frame.osd?.hSpeed || frame.osd?.vSpeed || 0),
      battery: parseFloat(frame.battery || frame.batteryPercent || frame.osd?.battery || 0),
      gpsSignal: parseFloat(frame.gpsSignal || frame.satelliteCount || frame.osd?.gpsLevel || 0)
    }));
  }

  // Fallback method for manual decryption attempts
  decryptWithFallbackMethod(filePath: string): DroneLogEntry[] {
    const encryptedData = fs.readFileSync(filePath);
    console.log(`🔧 Using fallback method for ${path.basename(filePath)}`);

    const decryptionMethods = [
      { name: 'Base64', method: () => this.tryBase64Decode(encryptedData) },
      { name: 'XOR (0x73)', method: () => this.tryXORDecryption(encryptedData, 0x73) },
      { name: 'XOR (0x4A)', method: () => this.tryXORDecryption(encryptedData, 0x4A) },
      { name: 'Simple Shift', method: () => this.trySimpleShift(encryptedData, 1) },
      { name: 'Raw Parsing', method: () => this.tryRawParsing(encryptedData) }
    ];

    for (const { name, method } of decryptionMethods) {
      try {
        console.log(`🔍 Trying ${name} decryption...`);
        const decrypted = method();
        if (this.isValidLogData(decrypted)) {
          console.log(`✅ Successfully decrypted with ${name} method`);
          return this.parseLogData(decrypted);
        }
      } catch (e) {
        console.log(`❌ ${name} method failed`);
      }
    }

    console.warn('❌ All decryption methods failed. This may be an encrypted v13+ log that requires DJI API key.');
    return [];
  }

  // Base64 decoding attempt
  private tryBase64Decode(data: Buffer): string {
    const base64String = data.toString('utf8');
    return Buffer.from(base64String, 'base64').toString('utf8');
  }

  // XOR decryption attempt
  private tryXORDecryption(data: Buffer, key: number): string {
    const decrypted = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      decrypted[i] = data[i] ^ key;
    }
    return decrypted.toString('utf8');
  }

  // Simple shift cipher attempt
  private trySimpleShift(data: Buffer, shift: number): string {
    const decrypted = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      decrypted[i] = data[i] - shift;
    }
    return decrypted.toString('utf8');
  }

  // Try parsing as raw data
  private tryRawParsing(data: Buffer): string {
    return data.toString('utf8');
  }

  // Enhanced validation of decrypted data
  private isValidLogData(data: string): boolean {
    const lowerData = data.toLowerCase();
    const hasLogIndicators = (
      lowerData.includes('lat') || 
      lowerData.includes('gps') || 
      lowerData.includes('altitude') || 
      lowerData.includes('battery') ||
      lowerData.includes('"timestamp"') ||
      lowerData.includes('{"')
    );
    
    const hasStructure = data.includes(',') && data.split(',').length > 5;
    const hasReasonableLength = data.length > 100;
    const notTooMuchGarbage = (data.match(/[^\x20-\x7E\n\r\t]/g) || []).length < data.length * 0.5;
    
    return hasReasonableLength && (hasLogIndicators || hasStructure) && notTooMuchGarbage;
  }

  // Enhanced log data parsing
  parseLogData(logContent: string): DroneLogEntry[] {
    const entries: DroneLogEntry[] = [];
    const lines = logContent.split('\n');

    for (const line of lines) {
      if (line.trim() === '') continue;

      try {
        const entry = this.parseLogLine(line);
        if (entry) {
          entries.push(entry);
        }
      } catch (error) {
        // Skip invalid lines silently
      }
    }

    return entries;
  }

  // Enhanced log line parsing
  private parseLogLine(line: string): DroneLogEntry | null {
    // Try JSON format first
    try {
      const jsonData = JSON.parse(line);
      return {
        timestamp: jsonData.timestamp || jsonData.time || jsonData.datetime || new Date().toISOString(),
        latitude: parseFloat(jsonData.latitude || jsonData.lat || 0),
        longitude: parseFloat(jsonData.longitude || jsonData.lon || jsonData.lng || 0),
        altitude: parseFloat(jsonData.altitude || jsonData.alt || 0),
        speed: parseFloat(jsonData.speed || jsonData.velocity || jsonData.vel || 0),
        battery: parseFloat(jsonData.battery || jsonData.bat || jsonData.batteryLevel || 0),
        gpsSignal: parseFloat(jsonData.gpsSignal || jsonData.gps || jsonData.satelliteCount || 0)
      };
    } catch (e) {
      // Try comma-separated values
      const parts = line.split(',');
      if (parts.length >= 3) {
        return {
          timestamp: parts[0] || new Date().toISOString(),
          latitude: parseFloat(parts[1]) || 0,
          longitude: parseFloat(parts[2]) || 0,
          altitude: parseFloat(parts[3]) || 0,
          speed: parseFloat(parts[4]) || 0,
          battery: parseFloat(parts[5]) || 0,
          gpsSignal: parseFloat(parts[6]) || 0
        };
      }
    }

    return null;
  }

  // Enhanced CSV output with better formatting
  convertToCSV(entries: DroneLogEntry[]): string {
    if (entries.length === 0) {
      return 'timestamp,latitude,longitude,altitude,speed,battery,gpsSignal\n';
    }

    const headers = Object.keys(entries[0]).join(',');
    const rows = entries.map(entry => 
      Object.values(entry).map(value => {
        if (typeof value === 'string') {
          // Handle timestamps and strings
          return `"${value}"`;
        } else if (typeof value === 'number') {
          // Format numbers to reasonable precision
          return Number.isInteger(value) ? value.toString() : value.toFixed(6);
        }
        return value;
      }).join(',')
    );

    return [headers, ...rows].join('\n');
  }

  // Enhanced main processing function
  async processAllLogs(): Promise<void> {
    console.log('🚁 DJI Drone Log Converter');
    console.log('==========================');
    console.log('');

    this.setupFolders();
    this.validateConfiguration();

    try {
      const files = fs.readdirSync(this.inputFolder);
      const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));

      if (txtFiles.length === 0) {
        console.log('📂 No .txt files found in the drone-logs folder');
        console.log(`   Please place your DJI .txt files in: ${this.inputFolder}`);
        return;
      }

      this.stats.totalFiles = txtFiles.length;
      console.log(`📋 Found ${txtFiles.length} .txt file(s) to process`);
      console.log('');

      for (const file of txtFiles) {
        console.log(`🔄 Processing: ${file}`);
        await this.processFile(file);
        console.log('');
      }

      this.printSummary();
    } catch (error) {
      console.error('❌ Error processing files:', this.getErrorMessage(error));
    }
  }

  // Validate configuration
  private validateConfiguration(): void {
    if (!this.apiKey) {
      console.log('⚠️  No DJI API key found in .env file.');
      console.log('   This will only work for older (pre-version 13) logs.');
      console.log('   For encrypted logs, add DJI_API_KEY to your .env file.');
      console.log('');
    } else {
      console.log('✅ DJI API key loaded from .env file');
      console.log('');
    }
  }

  // Enhanced file processing with better error handling
  private async processFile(filename: string): Promise<void> {
    const inputPath = path.join(this.inputFolder, filename);
    const outputFilename = `csv-drone-data-${path.parse(filename).name}.csv`;
    const outputPath = path.join(this.outputFolder, outputFilename);

    try {
      console.log(`📁 Reading file: ${filename}`);
      const fileSize = fs.statSync(inputPath).size;
      console.log(`📏 File size: ${(fileSize / 1024).toFixed(1)} KB`);
      
      const logEntries = await this.decryptWithDJILogParser(inputPath);

      if (logEntries.length === 0) {
        console.warn(`⚠️  No valid data found in ${filename}`);
        console.log('   This might be an encrypted log that requires a DJI API key.');
        this.stats.failedFiles++;
        return;
      }

      console.log(`📊 Parsed ${logEntries.length} log entries`);
      this.stats.totalEntries += logEntries.length;

      const csvContent = this.convertToCSV(logEntries);
      fs.writeFileSync(outputPath, csvContent);
      
      const outputSize = fs.statSync(outputPath).size;
      console.log(`✅ CSV saved to: ${outputPath}`);
      console.log(`📏 Output size: ${(outputSize / 1024).toFixed(1)} KB`);
      
      this.stats.successfulFiles++;
    } catch (error) {
      console.error(`❌ Error processing ${filename}:`, this.getErrorMessage(error));
      this.stats.failedFiles++;
    }
  }

  // Print processing summary
  private printSummary(): void {
    console.log('📊 Processing Summary');
    console.log('====================');
    console.log(`📁 Total files: ${this.stats.totalFiles}`);
    console.log(`✅ Successful: ${this.stats.successfulFiles}`);
    console.log(`❌ Failed: ${this.stats.failedFiles}`);
    console.log(`📋 Total entries: ${this.stats.totalEntries}`);
    console.log('');
    
    if (this.stats.successfulFiles > 0) {
      console.log(`🎉 Successfully converted ${this.stats.successfulFiles} file(s)!`);
      console.log(`📂 Check the 'csv-output' folder for your converted files.`);
    }
  }

  // Helper to safely extract error messages
  private getErrorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) {
      return (error as { message: string }).message;
    }
    return String(error);
  }
}

// Main execution
async function main() {
  try {
    const converter = new DJILogConverter();
    await converter.processAllLogs();
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run the converter
if (require.main === module) {
  main().catch(console.error);
}

export { DJILogConverter };