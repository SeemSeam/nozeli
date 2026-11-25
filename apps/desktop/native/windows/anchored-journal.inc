// Private journal lifetime custody. The lease retains the sole data-writer
// HANDLE of the original final-name file: FILE_SHARE_READ sharing denies every
// other data writer, deleter and namespace replacement while it is held. No
// path reopen, deletion fallback or ACL repair exists; a partial or
// size-unknown mutation poisons the lease permanently except for close().
#include <bcrypt.h>
struct PrivateJournal {
  std::shared_ptr<DirectoryChain> parent;
  std::unique_ptr<Handle> file;
  Snapshot initial{};
  SecuritySnapshot parentSecurity, security;
  bool poisoned = false;
  static Failure Poisoned() {
    Failure error("FS_JOURNAL_POISONED", "Journal lease failed permanently after a partial or unknown mutation");
    error.committed = true;
    return error;
  }
  void RequireUsable() const {
    if (!file) throw Failure("FS_HANDLE_CLOSED", "Private journal closed");
    if (poisoned) throw Poisoned();
  }
  void Verify() const {
    RequireUsable();
    if (!parent->Stable() || !parentSecurity.Matches(parent->Parent()) ||
        !Same(initial, Inspect(file->value, false), false) || !security.Matches(file->value))
      throw Failure("FS_STAGE_CHANGED", "Private journal identity, bytes or policy changed");
    RequireDefaultStreams(file->value, false);
  }
};
const napi_type_tag privateJournalTag = {0x5c9e1a74f0b28d36ULL, 0x834ad1c67e09f4b2ULL};
struct JournalBytes { void* data; size_t size; };
JournalBytes JournalBytesArgument(napi_env env, napi_value value, size_t limit) {
  bool typed = false;
  Check(napi_is_typedarray(env, value, &typed));
  if (!typed) throw Failure("FS_WRITE_LIMIT", "Expected a non-shared Uint8Array");
  void* bytes; size_t size, offsetInBuffer; napi_typedarray_type type; napi_value backing;
  Check(napi_get_typedarray_info(env, value, &type, &size, &bytes, &backing, &offsetInBuffer));
  bool arrayBuffer = false; Check(napi_is_arraybuffer(env, backing, &arrayBuffer));
  if (type != napi_uint8_array || !arrayBuffer || size > limit)
    throw Failure("FS_WRITE_LIMIT", "Expected a non-shared Uint8Array within the journal byte limit");
  return {bytes, size};
}
napi_value PrivateJournalClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto journal = Receiver<PrivateJournal>(env, info, &privateJournalTag);
    journal->file.reset(); journal->parent.reset(); return Undefined(env);
  });
}
napi_value PrivateJournalVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<PrivateJournal>(env, info, &privateJournalTag)->Verify(); return Undefined(env); });
}
napi_value PrivateJournalStat(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto journal = Receiver<PrivateJournal>(env, info, &privateJournalTag); journal->Verify();
    napi_value object, value; Check(napi_create_object(env, &object));
    const auto identity = DirectoryIdentityText(journal->initial);
    Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); Check(napi_set_named_property(env, object, "identity", value));
    Check(napi_create_bigint_int64(env, journal->initial.standard.EndOfFile.QuadPart, &value)); Check(napi_set_named_property(env, object, "size", value));
    return object;
  });
}
napi_value PrivateJournalReadAt(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto journal = Receiver<PrivateJournal>(env, info, &privateJournalTag, &count, args); journal->Verify();
    if (count != 2) throw Failure("FS_READ_LIMIT", "Expected journal offset and byte count");
    double numbers[2];
    for (size_t i = 0; i < 2; i++) {
      napi_valuetype type; Check(napi_typeof(env, args[i], &type));
      if (type != napi_number) throw Failure("FS_READ_LIMIT", "Expected numeric journal offset and byte count");
      Check(napi_get_value_double(env, args[i], &numbers[i]));
    }
    if (!(numbers[0] >= 0 && numbers[0] <= 9007199254740991.0) || numbers[0] != static_cast<LONGLONG>(numbers[0]) ||
        !(numbers[1] >= 1 && numbers[1] <= 1048576) || numbers[1] != static_cast<DWORD>(numbers[1]))
      throw Failure("FS_READ_LIMIT", "Expected safe integer offset and 1..1048576 journal bytes");
    LARGE_INTEGER offset; offset.QuadPart = static_cast<LONGLONG>(numbers[0]);
    if (!SetFilePointerEx(journal->file->value, offset, nullptr, FILE_BEGIN)) throw Failure("WIN32_IO_ERROR", "Journal seek failed", GetLastError());
    std::vector<char> bytes(static_cast<size_t>(numbers[1])); DWORD read = 0;
    if (!ReadFile(journal->file->value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      throw Failure("WIN32_IO_ERROR", "Journal read failed", GetLastError());
    journal->Verify(); napi_value result; Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result)); return result;
  });
}
napi_value PrivateJournalSync(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto journal = Receiver<PrivateJournal>(env, info, &privateJournalTag); journal->Verify();
    if (!FlushFileBuffers(journal->file->value)) throw Failure("FS_FILE_SYNC_FAILED", "Private journal flush failed", GetLastError());
    journal->Verify(); return Undefined(env);
  });
}
// A post-mutation failure can never report clean refusal: the bytes or size
// may already be committed, so the lease is poisoned with uncertain facts.
#define JOURNAL_COMMIT_UNKNOWN(journal) \
  catch (Failure& error) { error.committed = true; journal->poisoned = true; throw; } \
  catch (const std::exception&) { journal->poisoned = true; throw PrivateJournal::Poisoned(); }
napi_value PrivateJournalAppend(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto journal = Receiver<PrivateJournal>(env, info, &privateJournalTag, &count, args);
    journal->RequireUsable();
    if (count != 2) throw Failure("FS_WRITE_LIMIT", "Expected journal bytes and current size");
    const auto bytes = JournalBytesArgument(env, args[0], 1024 * 1024);
    LONGLONG expectedSize = -1;
    napi_valuetype type; Check(napi_typeof(env, args[1], &type));
    if (type == napi_number) {
      double number = 0; Check(napi_get_value_double(env, args[1], &number));
      if (!(number >= 0 && number <= 9007199254740991.0) || number != static_cast<LONGLONG>(number))
        throw Failure("FS_WRITE_LIMIT", "Expected a safe integer current journal size");
      expectedSize = static_cast<LONGLONG>(number);
    } else if (type == napi_bigint) {
      bool lossless = false; int64_t value = 0;
      Check(napi_get_value_bigint_int64(env, args[1], &value, &lossless));
      if (!lossless || value < 0 || value > 9007199254740991ll)
        throw Failure("FS_WRITE_LIMIT", "Expected a safe integer current journal size");
      expectedSize = value;
    } else throw Failure("FS_WRITE_LIMIT", "Expected a numeric current journal size");
    if (expectedSize + static_cast<LONGLONG>(bytes.size) > 9007199254740991ll)
      throw Failure("FS_WRITE_LIMIT", "Journal append would exceed the safe integer size limit");
    journal->Verify();
    const auto facts = Inspect(journal->file->value, false);
    if (facts.standard.EndOfFile.QuadPart != expectedSize)
      throw Failure("FS_JOURNAL_SIZE_MISMATCH", "Journal size differs from the expected append offset");
    LARGE_INTEGER offset; offset.QuadPart = expectedSize;
    if (!SetFilePointerEx(journal->file->value, offset, nullptr, FILE_BEGIN))
      throw Failure("WIN32_IO_ERROR", "Journal append seek failed", GetLastError());
    try {
      // Write directly from the caller's Uint8Array; no intermediate copy.
      size_t written = 0;
      while (written < bytes.size) {
        DWORD progress = 0;
        if (!WriteFile(journal->file->value, static_cast<char*>(bytes.data) + written,
            static_cast<DWORD>(bytes.size - written), &progress, nullptr))
          throw Failure("WIN32_IO_ERROR", "Journal append failed after a partial write", GetLastError());
        if (!progress) throw Failure("WIN32_IO_ERROR", "Journal append made no progress");
        written += progress;
      }
      const auto updated = Inspect(journal->file->value, false);
      if (updated.standard.EndOfFile.QuadPart != expectedSize + static_cast<LONGLONG>(bytes.size))
        throw Failure("FS_JOURNAL_SIZE_MISMATCH", "Journal size unknown after append");
      journal->initial = updated;
      journal->Verify();
      return Undefined(env);
    } JOURNAL_COMMIT_UNKNOWN(journal)
  });
}
napi_value PrivateJournalRewrite(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto journal = Receiver<PrivateJournal>(env, info, &privateJournalTag, &count, args);
    journal->RequireUsable();
    if (count != 2) throw Failure("FS_WRITE_LIMIT", "Expected journal bytes and expected original SHA-256");
    const auto bytes = JournalBytesArgument(env, args[0], 64 * 1024 * 1024);
    const auto expected = JournalBytesArgument(env, args[1], 32);
    if (expected.size != 32) throw Failure("FS_JOURNAL_DIGEST_MISMATCH", "Expected a 32-byte SHA-256 digest");
    journal->Verify();
    BCRYPT_HASH_HANDLE value = nullptr;
    if (BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &value, nullptr, 0, nullptr, 0, 0) < 0)
      throw Failure("FS_JOURNAL_HASH_FAILED", "Cannot hash journal content");
    struct HashHandle {
      BCRYPT_HASH_HANDLE value;
      ~HashHandle() { if (value) BCryptDestroyHash(value); }
    } hash{value};
    LARGE_INTEGER start{}; LONGLONG remaining = journal->initial.standard.EndOfFile.QuadPart;
    if (!SetFilePointerEx(journal->file->value, start, nullptr, FILE_BEGIN))
      throw Failure("WIN32_IO_ERROR", "Journal rewrite seek failed", GetLastError());
    std::vector<char> chunk(1024 * 1024);
    while (remaining > 0) {
      const auto want = static_cast<DWORD>((std::min)(remaining, static_cast<LONGLONG>(chunk.size())));
      DWORD read = 0;
      if (!ReadFile(journal->file->value, chunk.data(), want, &read, nullptr) || read != want)
        throw Failure("FS_STAGE_CHANGED", "Journal content shortened while hashing");
      if (BCryptHashData(hash.value, reinterpret_cast<PUCHAR>(chunk.data()), read, 0) < 0)
        throw Failure("FS_JOURNAL_HASH_FAILED", "Cannot hash journal content");
      remaining -= read;
    }
    BYTE digest[32]{};
    if (BCryptFinishHash(hash.value, digest, sizeof(digest), 0) < 0 ||
        memcmp(digest, expected.data, 32) != 0)
      throw Failure("FS_JOURNAL_DIGEST_MISMATCH", "Journal digest differs from the expected original content");
    try {
      if (!SetFilePointerEx(journal->file->value, start, nullptr, FILE_BEGIN))
        throw Failure("WIN32_IO_ERROR", "Journal rewrite seek failed", GetLastError());
      size_t written = 0;
      while (written < bytes.size) {
        const auto want = static_cast<DWORD>((std::min)(bytes.size - written, static_cast<size_t>(1024 * 1024)));
        DWORD progress = 0;
        if (!WriteFile(journal->file->value, static_cast<char*>(bytes.data) + written, want, &progress, nullptr))
          throw Failure("WIN32_IO_ERROR", "Journal rewrite failed after a partial write", GetLastError());
        if (!progress) throw Failure("WIN32_IO_ERROR", "Journal rewrite made no progress");
        written += progress;
      }
      if (static_cast<LONGLONG>(bytes.size) < journal->initial.standard.EndOfFile.QuadPart) {
        FILE_END_OF_FILE_INFO end{};
        end.EndOfFile.QuadPart = static_cast<LONGLONG>(bytes.size);
        if (!SetFileInformationByHandle(journal->file->value, FileEndOfFileInfo, &end, sizeof(end)))
          throw Failure("WIN32_IO_ERROR", "Journal truncation failed after rewrite", GetLastError());
      }
      const auto updated = Inspect(journal->file->value, false);
      if (updated.standard.EndOfFile.QuadPart != static_cast<LONGLONG>(bytes.size))
        throw Failure("FS_JOURNAL_SIZE_MISMATCH", "Journal size unknown after rewrite");
      journal->initial = updated;
      journal->Verify();
      return Undefined(env);
    } JOURNAL_COMMIT_UNKNOWN(journal)
  });
}
napi_value OpenPrivateJournal(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, args);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Private journal parent closed");
    if (count != 2) throw Failure("FS_NAME_REJECTED", "Expected journal filename and createOnly boolean");
    const auto name = Name(env, args[0]);
    bool createOnly = false; Check(napi_get_value_bool(env, args[1], &createOnly));
    if (!parent->chain->directorySync || !parent->chain->Stable())
      throw Failure("FS_STAGE_CHANGED", "Journal parent changed");
    auto journal = std::make_unique<PrivateJournal>();
    journal->parent = parent->chain;
    journal->parentSecurity = SecuritySnapshot::Read(parent->chain->Parent());
    journal->parentSecurity.RequirePrivate(true);
    PrivateSecurity created(false); ULONG_PTR information = 0;
    // FILE_SHARE_READ alone makes this HANDLE the exclusive data writer: any
    // other writer, deleter or namespace replacement open fails while held.
    // FILE_CREATE publishes the exact final name once; the same HANDLE is then
    // used for every lease operation, so no reopen gap ever exists.
    journal->file = OpenChild(parent->chain->Parent(), name, false,
      GENERIC_READ | GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE,
      createOnly ? 2 : 1, createOnly ? &created.descriptor : nullptr, FILE_SHARE_READ, &information);
    try {
      journal->initial = Inspect(journal->file->value, false);
      if (journal->initial.standard.NumberOfLinks != 1)
        throw Failure("FS_ENTRY_REJECTED", "Private journal must have one link");
      journal->security = SecuritySnapshot::Read(journal->file->value);
      journal->security.RequireInheritedUserFile();
      journal->Verify();
    } catch (Failure& error) {
      if (information == 2) error.committed = true;
      throw;
    } catch (const std::exception&) {
      Failure error("NATIVE_BINDING_ERROR", "Private journal open failed; reconcile any created entry");
      error.committed = information == 2; throw error;
    }
    napi_value object, value; Check(napi_create_object(env, &object));
    Check(napi_type_tag_object(env, object, &privateJournalTag));
    Check(napi_get_boolean(env, information == 2 /* FILE_CREATED */, &value));
    Check(napi_set_named_property(env, object, "created", value));
    napi_property_descriptor methods[] = {
      {"stat", nullptr, PrivateJournalStat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"verify", nullptr, PrivateJournalVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readAt", nullptr, PrivateJournalReadAt, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"append", nullptr, PrivateJournalAppend, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"rewrite", nullptr, PrivateJournalRewrite, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"sync", nullptr, PrivateJournalSync, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, PrivateJournalClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods));
    Check(napi_wrap(env, object, journal.get(), [](napi_env, void* data, void*) { delete static_cast<PrivateJournal*>(data); }, nullptr, nullptr));
    journal.release(); return object;
  });
}
