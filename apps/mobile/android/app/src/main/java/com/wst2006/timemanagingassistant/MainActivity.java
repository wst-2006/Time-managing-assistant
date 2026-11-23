package com.wst2006.timemanagingassistant;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own data store; registered before the web app starts.
        registerPlugin(LocalSqlitePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
