package com.wst2006.timemanagingassistant;

import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The app's data store: one SQLite file in the app's private storage, using the
 * SQLite that ships inside the app (androidx.sqlite bundled), so every phone gets
 * the same SQLite version whatever its system version is.
 *
 * The web side sends one statement at a time and gets back column names and rows
 * as arrays. Calls run on Capacitor's plugin thread, one after another.
 */
@CapacitorPlugin(name = "LocalSqlite")
public class LocalSqlitePlugin extends Plugin {

    private static final int TYPE_INTEGER = 1;
    private static final int TYPE_FLOAT = 2;
    private static final int TYPE_TEXT = 3;
    private static final int TYPE_BLOB = 4;

    private SQLiteConnection connection;

    @PluginMethod
    public synchronized void open(PluginCall call) {
        try {
            if (connection == null) {
                String name = call.getString("name", "tma.sqlite");
                File file = getContext().getDatabasePath(name);
                File parent = file.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                connection = new BundledSQLiteDriver().open(file.getAbsolutePath());
                run("PRAGMA journal_mode = WAL");
                run("PRAGMA synchronous = NORMAL");
                run("PRAGMA foreign_keys = ON");
                run("PRAGMA busy_timeout = 5000");
            }
            JSObject result = new JSObject();
            result.put("version", queryVersion());
            call.resolve(result);
        } catch (Throwable error) {
            call.reject(describe(error), error instanceof Exception ? (Exception) error : null);
        }
    }

    @PluginMethod
    public synchronized void query(PluginCall call) {
        if (connection == null) {
            call.reject("Database not opened");
            return;
        }
        String sql = call.getString("sql");
        JSArray params = call.getArray("params", new JSArray());
        SQLiteStatement statement = null;
        try {
            statement = connection.prepare(sql);
            for (int i = 0; i < params.length(); i++) bind(statement, i + 1, params.get(i));
            int columnCount = statement.getColumnCount();
            JSArray columns = new JSArray();
            for (int i = 0; i < columnCount; i++) columns.put(statement.getColumnName(i));
            JSONArray rows = new JSONArray();
            while (statement.step()) {
                JSONArray row = new JSONArray();
                for (int i = 0; i < columnCount; i++) row.put(read(statement, i));
                rows.put(row);
            }
            statement.close();
            statement = null;
            JSObject result = new JSObject();
            result.put("columns", columns);
            result.put("rows", rows);
            result.put("changes", columnCount == 0 || isWrite(sql) ? changes() : 0);
            call.resolve(result);
        } catch (Throwable error) {
            call.reject(describe(error), error instanceof Exception ? (Exception) error : null);
        } finally {
            if (statement != null) {
                try { statement.close(); } catch (Throwable ignored) { }
            }
        }
    }

    private void run(String sql) {
        SQLiteStatement statement = connection.prepare(sql);
        try {
            while (statement.step()) { /* PRAGMA rows are not needed */ }
        } finally {
            statement.close();
        }
    }

    private String queryVersion() {
        SQLiteStatement statement = connection.prepare("SELECT sqlite_version()");
        try {
            return statement.step() ? statement.getText(0) : "";
        } finally {
            statement.close();
        }
    }

    private long changes() {
        SQLiteStatement statement = connection.prepare("SELECT changes()");
        try {
            return statement.step() ? statement.getLong(0) : 0;
        } finally {
            statement.close();
        }
    }

    private static boolean isWrite(String sql) {
        String head = sql.trim().toLowerCase();
        return head.startsWith("insert") || head.startsWith("update") || head.startsWith("delete") || head.startsWith("with");
    }

    private static void bind(SQLiteStatement statement, int index, Object value) {
        if (value == null || value == JSONObject.NULL) {
            statement.bindNull(index);
        } else if (value instanceof Boolean) {
            statement.bindLong(index, ((Boolean) value) ? 1 : 0);
        } else if (value instanceof Integer || value instanceof Long || value instanceof Short) {
            statement.bindLong(index, ((Number) value).longValue());
        } else if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (number == Math.rint(number) && Math.abs(number) < 9.0E15) statement.bindLong(index, (long) number);
            else statement.bindDouble(index, number);
        } else {
            statement.bindText(index, value.toString());
        }
    }

    private static Object read(SQLiteStatement statement, int index) {
        if (statement.isNull(index)) return JSONObject.NULL;
        switch (statement.getColumnType(index)) {
            case TYPE_INTEGER:
                return statement.getLong(index);
            case TYPE_FLOAT:
                return statement.getDouble(index);
            case TYPE_BLOB:
                return android.util.Base64.encodeToString(statement.getBlob(index), android.util.Base64.NO_WRAP);
            case TYPE_TEXT:
            default:
                return statement.getText(index);
        }
    }

    private static String describe(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.toString() : message;
    }
}
