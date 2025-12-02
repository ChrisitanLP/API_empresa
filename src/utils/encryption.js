// Constants
const CRYPTO_CONSTANTS = {
    BLOCK_SIZE: 16,
    KEY_SIZE_192: 24,
    ROUNDS_192: 12,
    NUM_COLUMNS: 4,
    PADDING_MARKER: '',
  };
  
  // Utility class for byte operations
  class ByteUtils {
    static stringToBytes(str) {
      return Array.from(str).map(char => char.charCodeAt(0));
    }
  
    static bytesToString(bytes) {
      return String.fromCharCode.apply(null, bytes);
    }
  
    static xorArrays(arr1, arr2) {
      return arr1.map((byte, i) => byte ^ arr2[i]);
    }
  }
  
  // Class for handling padding operations
  class PaddingHandler {
    static padPKCS7(data, blockSize = CRYPTO_CONSTANTS.BLOCK_SIZE) {
      const padding = blockSize - (data.length % blockSize);
      return [...data, ...new Array(padding).fill(padding)];
    }
  
    static unpadPKCS7(data) {
      const paddingLength = data[data.length - 1];
      return data.slice(0, -paddingLength);
    }
  }
  
  // Class containing substitution tables and round constants
  class AESConstants {
    static SBOX = [
      0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
      0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
      0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
      0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
      0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
      0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
      0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
      0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
      0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
      0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
      0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
      0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
      0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
      0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
      0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
      0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
    ];
  
    static RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0x6c, 0x6c, 0x6c, 0x6c, 0x6c];
  
    static INV_SBOX = (() => {
      const invBox = new Array(256);
      for (let i = 0; i < 256; i++) {
        invBox[AESConstants.SBOX[i]] = i;
      }
      return invBox;
    })();
  }
  
  // Class handling AES transformations
  class AESTransformations {
    static subBytes(state) {
      return state.map(byte => AESConstants.SBOX[byte]);
    }
  
    static invSubBytes(state) {
      return state.map(byte => AESConstants.INV_SBOX[byte]);
    }
  
    static shiftRows(state) {
      return [
        state[0], state[5], state[10], state[15],
        state[4], state[9], state[14], state[3],
        state[8], state[13], state[2], state[7],
        state[12], state[1], state[6], state[11]
      ];
    }
  
    static invShiftRows(state) {
      return [
        state[0], state[13], state[10], state[7],
        state[4], state[1], state[14], state[11],
        state[8], state[5], state[2], state[15],
        state[12], state[9], state[6], state[3]
      ];
    }
  
    static mixColumns(state) {
      return this._mixColumnsOperation(state, {
        m1: 2,
        m2: 3,
        m3: 1,
        m4: 1
      });
    }
  
    static invMixColumns(state) {
      return this._mixColumnsOperation(state, {
        m1: 0x0E,
        m2: 0x0B,
        m3: 0x0D,
        m4: 0x09
      });
    }
  
    static _mixColumnsOperation(state, multipliers) {
      const multiply = this._galoisMultiply;
      const result = new Array(16);
  
      for (let i = 0; i < 4; i++) {
        const col = state.slice(i * 4, (i + 1) * 4);
        
        for (let j = 0; j < 4; j++) {
          const idx = i * 4 + j;
          result[idx] = multiply(col[j], multipliers.m1) ^
                       multiply(col[(j + 1) % 4], multipliers.m2) ^
                       multiply(col[(j + 2) % 4], multipliers.m3) ^
                       multiply(col[(j + 3) % 4], multipliers.m4);
        }
      }
      return result;
    }
  
    static _galoisMultiply(a, b) {
      let result = 0;
      for (let i = 0; i < 8; i++) {
        if (b & 1) result ^= a;
        const highBit = a & 0x80;
        a = (a << 1) & 0xFF;
        if (highBit) a ^= 0x1B;
        b >>>= 1;
      }
      return result;
    }
  }
  
  // Class handling key operations
  class KeyHandler {
    static expandKey(key) {
      const expandedKey = [...key];
      const { ROUNDS_192, NUM_COLUMNS } = CRYPTO_CONSTANTS;
      const Nk = 6; // Number of 32-bit words for AES-192
  
      for (let i = Nk; i < NUM_COLUMNS * (ROUNDS_192 + 1); i++) {
        let temp = expandedKey.slice((i - 1) * 4, i * 4);
  
        if (i % Nk === 0) {
          temp = [
            AESConstants.SBOX[temp[1]] ^ AESConstants.RCON[Math.floor(i / Nk) - 1],
            AESConstants.SBOX[temp[2]],
            AESConstants.SBOX[temp[3]],
            AESConstants.SBOX[temp[0]]
          ];
        } else if (i % Nk === 4) {
          temp = temp.map(byte => AESConstants.SBOX[byte]);
        }
  
        const prevKey = expandedKey.slice((i - Nk) * 4, (i - Nk + 1) * 4);
        expandedKey.push(...ByteUtils.xorArrays(prevKey, temp));
      }
  
      return expandedKey;
    }
  }
  
  // Main AES class
  class AES {
    constructor(key) {
      if (!key || typeof key !== 'string') {
        throw new Error('Invalid key provided');
      }
      this.key = key;
      this.keyBytes = ByteUtils.stringToBytes(key.padEnd(CRYPTO_CONSTANTS.KEY_SIZE_192, '\0'))
        .slice(0, CRYPTO_CONSTANTS.KEY_SIZE_192);
      this.expandedKey = KeyHandler.expandKey(this.keyBytes);
    }
  
    encrypt(text) {
      if (!text || typeof text !== 'string') {
        throw new Error('Invalid input text');
      }
  
      const textWithMarker = text + CRYPTO_CONSTANTS.PADDING_MARKER;
      const textBytes = PaddingHandler.padPKCS7(ByteUtils.stringToBytes(textWithMarker));
      const encryptedBlocks = this._processBlocks(textBytes, this._encryptBlock.bind(this));
      
      return btoa(ByteUtils.bytesToString(encryptedBlocks));
    }
  
    decrypt(encryptedText) {
      if (!encryptedText || typeof encryptedText !== 'string') {
        throw new Error('Invalid encrypted text');
      }
  
      const encryptedBytes = ByteUtils.stringToBytes(atob(encryptedText));
      const decryptedBlocks = this._processBlocks(encryptedBytes, this._decryptBlock.bind(this));
      const decryptedText = ByteUtils.bytesToString(PaddingHandler.unpadPKCS7(decryptedBlocks));
      
      return decryptedText.slice(0, -CRYPTO_CONSTANTS.PADDING_MARKER.length);
    }
  
    _processBlocks(bytes, blockOperation) {
      const result = [];
      for (let i = 0; i < bytes.length; i += CRYPTO_CONSTANTS.BLOCK_SIZE) {
        const block = bytes.slice(i, i + CRYPTO_CONSTANTS.BLOCK_SIZE);
        const processedBlock = blockOperation(block);
        result.push(...processedBlock);
      }
      return result;
    }
  
    _encryptBlock(block) {
      let state = [...block];
      
      // Initial round
      state = ByteUtils.xorArrays(state, this.expandedKey.slice(0, 16));
      
      // Main rounds
      for (let round = 1; round < CRYPTO_CONSTANTS.ROUNDS_192; round++) {
        state = AESTransformations.subBytes(state);
        state = AESTransformations.shiftRows(state);
        state = AESTransformations.mixColumns(state);
        state = ByteUtils.xorArrays(state, this.expandedKey.slice(round * 16, (round + 1) * 16));
      }
      
      // Final round
      state = AESTransformations.subBytes(state);
      state = AESTransformations.shiftRows(state);
      state = ByteUtils.xorArrays(state, this.expandedKey.slice(CRYPTO_CONSTANTS.ROUNDS_192 * 16));
      
      return state;
    }
  
    _decryptBlock(block) {
      let state = [...block];
      
      // Initial round
      state = ByteUtils.xorArrays(state, this.expandedKey.slice(CRYPTO_CONSTANTS.ROUNDS_192 * 16));
      state = AESTransformations.invShiftRows(state);
      state = AESTransformations.invSubBytes(state);
      
      // Main rounds
      for (let round = CRYPTO_CONSTANTS.ROUNDS_192 - 1; round > 0; round--) {
        state = ByteUtils.xorArrays(state, this.expandedKey.slice(round * 16, (round + 1) * 16));
        state = AESTransformations.invMixColumns(state);
        state = AESTransformations.invShiftRows(state);
        state = AESTransformations.invSubBytes(state);
      }
      
      // Final round
      state = ByteUtils.xorArrays(state, this.expandedKey.slice(0, 16));
      
      return state;
    }
  }
  
module.exports = { AES };

   /* Example usage
  const aes = new AES('Nigga&Lopez&Mora');
  const encrypted = aes.encrypt('Hello, World!');
  console.log('Encrypted:', encrypted);
  const decrypted = aes.decrypt(encrypted);
  console.log('Decrypted:', decrypted);
  */