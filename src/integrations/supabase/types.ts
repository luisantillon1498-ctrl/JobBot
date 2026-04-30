export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      application_automation_sessions: {
        Row: {
          application_id: string
          created_at: string
          ended_at: string | null
          handoff_completed_at: string | null
          handoff_reason: string | null
          handoff_required_at: string | null
          id: string
          metadata: Json
          run_log: Json
          screenshot_storage_paths: Json
          started_at: string
          steel_live_url: string | null
          steel_session_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          application_id: string
          created_at?: string
          ended_at?: string | null
          handoff_completed_at?: string | null
          handoff_reason?: string | null
          handoff_required_at?: string | null
          id?: string
          metadata?: Json
          run_log?: Json
          screenshot_storage_paths?: Json
          started_at?: string
          steel_live_url?: string | null
          steel_session_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          application_id?: string
          created_at?: string
          ended_at?: string | null
          handoff_completed_at?: string | null
          handoff_reason?: string | null
          handoff_required_at?: string | null
          id?: string
          metadata?: Json
          run_log?: Json
          screenshot_storage_paths?: Json
          started_at?: string
          steel_live_url?: string | null
          steel_session_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_automation_sessions_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      application_documents: {
        Row: {
          application_id: string
          created_at: string
          document_id: string
          id: string
          user_id: string
        }
        Insert: {
          application_id: string
          created_at?: string
          document_id: string
          id?: string
          user_id: string
        }
        Update: {
          application_id?: string
          created_at?: string
          document_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_documents_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_documents_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      application_events: {
        Row: {
          application_id: string
          created_at: string
          description: string
          event_type: string
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          application_id: string
          created_at?: string
          description: string
          event_type: string
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          application_id?: string
          created_at?: string
          description?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_events_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      applications: {
        Row: {
          application_status: string
          applied_at: string | null
          automation_active_session_id: string | null
          automation_last_context: Json
          automation_last_error: string | null
          automation_last_outcome: string | null
          automation_last_run_at: string | null
          automation_live_url: string | null
          automation_queue_excluded: boolean
          automation_queue_priority: number
          automation_queue_state: string
          company_name: string
          created_at: string
          id: string
          job_description: string | null
          job_title: string
          job_url: string | null
          location: string | null
          notes: string | null
          outcome: string | null
          salary_range: string | null
          submission_status: string
          submitted_cover_document_id: string | null
          submitted_resume_document_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          application_status?: string
          applied_at?: string | null
          automation_active_session_id?: string | null
          automation_last_context?: Json
          automation_last_error?: string | null
          automation_last_outcome?: string | null
          automation_last_run_at?: string | null
          automation_live_url?: string | null
          automation_queue_excluded?: boolean
          automation_queue_priority?: number
          automation_queue_state?: string
          company_name: string
          created_at?: string
          id?: string
          job_description?: string | null
          job_title: string
          job_url?: string | null
          location?: string | null
          notes?: string | null
          outcome?: string | null
          salary_range?: string | null
          submission_status?: string
          submitted_cover_document_id?: string | null
          submitted_resume_document_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          application_status?: string
          applied_at?: string | null
          automation_active_session_id?: string | null
          automation_last_context?: Json
          automation_last_error?: string | null
          automation_last_outcome?: string | null
          automation_last_run_at?: string | null
          automation_live_url?: string | null
          automation_queue_excluded?: boolean
          automation_queue_priority?: number
          automation_queue_state?: string
          company_name?: string
          created_at?: string
          id?: string
          job_description?: string | null
          job_title?: string
          job_url?: string | null
          location?: string | null
          notes?: string | null
          outcome?: string | null
          salary_range?: string | null
          submission_status?: string
          submitted_cover_document_id?: string | null
          submitted_resume_document_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_automation_active_session_id_fkey"
            columns: ["automation_active_session_id"]
            isOneToOne: false
            referencedRelation: "application_automation_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_submitted_cover_document_id_fkey"
            columns: ["submitted_cover_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_submitted_resume_document_id_fkey"
            columns: ["submitted_resume_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string
          file_path: string
          file_size: number | null
          id: string
          name: string
          source_generated_artifact_id: string | null
          type: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          file_path: string
          file_size?: number | null
          id?: string
          name: string
          source_generated_artifact_id?: string | null
          type: string
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          created_at?: string
          file_path?: string
          file_size?: number | null
          id?: string
          name?: string
          source_generated_artifact_id?: string | null
          type?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "documents_source_generated_artifact_id_fkey"
            columns: ["source_generated_artifact_id"]
            isOneToOne: false
            referencedRelation: "generated_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_artifacts: {
        Row: {
          application_id: string
          content: string
          created_at: string
          generator_version: string
          id: string
          prompt_used: string | null
          type: string
          user_id: string
        }
        Insert: {
          application_id: string
          content: string
          created_at?: string
          generator_version?: string
          id?: string
          prompt_used?: string | null
          type: string
          user_id: string
        }
        Update: {
          application_id?: string
          content?: string
          created_at?: string
          generator_version?: string
          id?: string
          prompt_used?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_artifacts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string | null
          cover_letter_tone: string
          created_at: string
          date_of_birth: string | null
          default_resume_document_id: string | null
          disability_status: string
          first_name: string | null
          full_name: string | null
          gender: string | null
          hispanic_ethnicity: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          middle_name: string | null
          onboarded: boolean
          phone: string | null
          phone_country_code: string | null
          postal_code: string | null
          professional_email: string | null
          race_ethnicity: string | null
          resume_wizard_page_limit: number
          state_region: string | null
          updated_at: string
          user_id: string
          veteran_status: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          cover_letter_tone?: string
          created_at?: string
          date_of_birth?: string | null
          default_resume_document_id?: string | null
          disability_status?: string
          first_name?: string | null
          full_name?: string | null
          gender?: string | null
          hispanic_ethnicity?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          middle_name?: string | null
          onboarded?: boolean
          phone?: string | null
          phone_country_code?: string | null
          postal_code?: string | null
          professional_email?: string | null
          race_ethnicity?: string | null
          resume_wizard_page_limit?: number
          state_region?: string | null
          updated_at?: string
          user_id: string
          veteran_status?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          cover_letter_tone?: string
          created_at?: string
          date_of_birth?: string | null
          default_resume_document_id?: string | null
          disability_status?: string
          first_name?: string | null
          full_name?: string | null
          gender?: string | null
          hispanic_ethnicity?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          middle_name?: string | null
          onboarded?: boolean
          phone?: string | null
          phone_country_code?: string | null
          postal_code?: string | null
          professional_email?: string | null
          race_ethnicity?: string | null
          resume_wizard_page_limit?: number
          state_region?: string | null
          updated_at?: string
          user_id?: string
          veteran_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_default_resume_document_id_fkey"
            columns: ["default_resume_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      resume_features: {
        Row: {
          company: string
          created_at: string
          description_lines: string[]
          feature_type: Database["public"]["Enums"]["resume_feature_type"]
          from_date: string | null
          id: string
          role_title: string
          sort_order: number
          to_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          company?: string
          created_at?: string
          description_lines?: string[]
          feature_type?: Database["public"]["Enums"]["resume_feature_type"]
          from_date?: string | null
          id?: string
          role_title?: string
          sort_order?: number
          to_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          company?: string
          created_at?: string
          description_lines?: string[]
          feature_type?: Database["public"]["Enums"]["resume_feature_type"]
          from_date?: string | null
          id?: string
          role_title?: string
          sort_order?: number
          to_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      resume_feature_type:
        | "professional_experience"
        | "academics"
        | "extracurriculars"
        | "skills_and_certifications"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      resume_feature_type: [
        "professional_experience",
        "academics",
        "extracurriculars",
        "skills_and_certifications",
      ],
    },
  },
} as const
