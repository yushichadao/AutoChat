#pragma once
#include <cstdint>
#include <string>
#include <vector>

 
#pragma pack(push, 1)
struct WxStringSSO
{
    union
    {
        char* heap_buf;        // len > 0xF
        char  inline_buf[16];   // len <= 0xF（maxCount 16 char）
    };
    //uint64_t unk;   // 0x08 unknownField
    uint64_t len;   // 0x10
    uint64_t cap;   // 0x18
};
#pragma pack(pop)

std::string format_string(const char* format, ...);
std::wstring StringToWString(const std::string& str);
std::string WStringToString(const std::wstring& wstr);
std::string ExtractQuotedString(const std::string& str, size_t start_pos);
void InitStandardPaths();

// wechat base + offset
void* WeixinDll_Offset(uintptr_t offset);
void* WeixinExe_Offset(uintptr_t offset);

static bool IsReadable(const void* p, size_t len);
std::string ReadWxString(void* p);
static std::string StringToUtf8(const std::string& str);
bool EndsWith(const std::string& s, const std::string& suffix);

std::string GetCurrentTime_Seconds();
std::string GetCurrentTime_Milliseconds();
uint64_t Time_GetCurrentTimestamp(bool sec10 = false);
uint64_t GetTimestamp13();
uint64_t GetTimestamp10();

std::string Bytes_BytesToHex(const std::vector<uint8_t>& data);
std::vector<uint8_t> Bytes_HexToBytes(const std::string& hex);
std::vector<uint8_t> Code_Utf8Encode(const std::string& input);
uint64_t Time_ToTimestamp(const std::string& datetime);
std::string Time_TimestampToText(uint64_t timestamp);
std::string GetRunDir();
bool File_Exists(const std::string& path);
std::vector<uint8_t> ToByteArray(const std::string& input);
std::string Code_Base64Encode(const std::vector<unsigned char>& input);
std::vector<unsigned char> Code_Base64Decode(const std::string& textToEncode, bool TrimRightBytes = false);
std::string UTF8ToText(const std::vector<uint8_t>& data);
uint64_t Radix_HexToDec(const std::string& hexStr);
std::string Radix_DecToHex(uint64_t value, bool leadingZero = false);
std::string GetDataDigest(const std::vector<uint8_t>& data);
std::string ToLowerStr(const std::string& str);
std::string RemoveAllSpaces(const std::string& str);

std::string GetTextLeft(const std::string& str, size_t count);
std::string GetTextMid(const std::string& str, size_t start, size_t count);
std::string GetTextRight(const std::string& str, size_t count);
std::string GetDeviceUUID();
uint64_t File_GetSize(const std::string& filePath);
uint64_t get_md5_check_value(const std::string& sign);
uint64_t GetBytesLen(std::vector<uint8_t> bytes);
std::string ReplaceSubText(std::string oriText, std::string oldText, std::string newText);
std::string Url_GetParamValue(const std::string& url, const std::string& paramName);
std::string Code_UrlEncode(const std::string& textToEncode, bool keepAlnum);
uint64_t ToInt(std::string value);
std::string ToText(uint64_t value);
uint64_t ShiftRight(uint64_t value, int bits);
