package com.jarvis.companion

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * JARVIS Android Companion Client Foundation.
 * Connects over local LAN / VPN to the paired JARVIS desktop server using
 * bearer device credentials issued via POST /api/devices/pair.
 * Respects Android runtime permissions (RECORD_AUDIO, POST_NOTIFICATIONS).
 */
class JarvisCompanionClient(
    private val serverBaseUrl: String,
    private val deviceId: String,
    private val pairingToken: String
) {
    fun sendChatCommand(message: String, language: String = "auto"): JSONObject {
        val url = URL("${serverBaseUrl.trimEnd('/')}/api/chat")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("X-Jarvis-Device-Id", deviceId)
            setRequestProperty("Authorization", "Bearer $pairingToken")
            doOutput = true
            connectTimeout = 5000
            readTimeout = 20000
        }
        val payload = JSONObject().apply {
            put("content", message)
            put("language", language)
        }
        conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val responseText = conn.inputStream.bufferedReader().use { it.readText() }
        return JSONObject(responseText)
    }

    fun fetchTasks(): JSONObject {
        val url = URL("${serverBaseUrl.trimEnd('/')}/api/tasks")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("X-Jarvis-Device-Id", deviceId)
            setRequestProperty("Authorization", "Bearer $pairingToken")
        }
        return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
    }
}
